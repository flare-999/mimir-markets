/**
 * Observational agent reputation (docs/adr/0003-observational-reputation-v1.md).
 *
 * Three properties are pinned here:
 *
 *  1. The Wilson lower-bound formula is deterministic and matches hand-computed
 *     fixtures — a reputation that drifts between recomputations would be a
 *     second source of truth able to disagree with the settlements it describes.
 *  2. The sync worker's DB write is narrow: one UPDATE of `reputation_bps`,
 *     asserted on the bound arguments via the recording fake-pool pattern (see
 *     `db-address-fidelity.test.ts` for why that boundary is the right one).
 *  3. Reputation is observational, never authority: `authorizeAction` must not
 *     reference it, asserted by grep so a future edit cannot smuggle a
 *     reputation gate past review.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  MIN_REPUTATION_DECIDED,
  REPUTATION_VERSION,
  computeReputation,
  computeReputationFromRows,
  reconcileAgentReputations,
  wilsonLowerBoundBps,
} from "../../lib/agents/reputation";
import { classifyTrade, type AgentTradeRow } from "../../lib/agents/performance";

const NOW = 1_800_000_000_000;

/* ── Formula fixtures ─────────────────────────────────────────────────────── */

test("version and minimum sample are pinned", () => {
  assert.equal(REPUTATION_VERSION, 1);
  assert.equal(MIN_REPUTATION_DECIDED, 5);
});

test("below the minimum sample there is no number, only null", () => {
  assert.equal(wilsonLowerBoundBps(0, 0), null);
  assert.equal(wilsonLowerBoundBps(1, 0), null);
  assert.equal(wilsonLowerBoundBps(4, 0), null);
  assert.equal(wilsonLowerBoundBps(0, 4), null);
  assert.equal(wilsonLowerBoundBps(2, 2), null);
});

test("exactly at the minimum the bound exists and separates luck from skill", () => {
  // 5–0 is a hot streak, not a forecaster: the 95% floor sits just above a coin flip.
  const perfect = wilsonLowerBoundBps(5, 0);
  assert.ok(perfect !== null);
  assert.equal(perfect, 5655);
  // 0–5 floors at zero and can go no lower.
  assert.equal(wilsonLowerBoundBps(0, 5), 0);
});

test("fixtures: hand-computed Wilson lower bounds", () => {
  assert.equal(wilsonLowerBoundBps(4, 2), 3000);
  assert.equal(wilsonLowerBoundBps(3, 2), 2307);
  assert.equal(wilsonLowerBoundBps(50, 50), 4038);
  assert.equal(wilsonLowerBoundBps(90, 10), 8256);
});

test("a larger identical win rate never scores lower", () => {
  // Monotonicity in wins: 6–4 must beat 3–2, which must beat 5–0's floor once
  // the sample grows — the property that stops a lucky 1–0 topping a proven 90–30.
  const small = wilsonLowerBoundBps(3, 2)!;
  const larger = wilsonLowerBoundBps(30, 20)!;
  assert.ok(larger > small, `expected ${larger} > ${small}`);
  const proven = wilsonLowerBoundBps(90, 30)!;
  assert.ok(proven > larger, `expected ${proven} > ${larger}`);
});

test("adding a loss can never raise the bound; adding a win can never lower it", () => {
  for (const [w, l] of [[5, 0], [8, 3], [20, 15], [1, 4]] as const) {
    const base = wilsonLowerBoundBps(w, l)!;
    const withLoss = wilsonLowerBoundBps(w, l + 1)!;
    const withWin = wilsonLowerBoundBps(w + 1, l)!;
    assert.ok(withLoss <= base, `loss lowered nothing at ${w}/${l}`);
    assert.ok(withWin >= base, `win raised nothing at ${w}/${l}`);
  }
});

test("the bound stays within basis-point range", () => {
  for (const [w, l] of [[5, 0], [0, 5], [100, 0], [0, 100], [50, 50], [999, 1]] as const) {
    const bps = wilsonLowerBoundBps(w, l)!;
    assert.ok(bps >= 0 && bps <= 10_000, `bps ${bps} out of range for ${w}/${l}`);
  }
});

test("the formula is deterministic — identical input, identical output", () => {
  const a = wilsonLowerBoundBps(17, 11)!;
  for (let i = 0; i < 5; i++) assert.equal(wilsonLowerBoundBps(17, 11), a);
});

test("negative or non-finite counts are refused, never coerced to a number", () => {
  assert.equal(wilsonLowerBoundBps(-1, 5), null);
  assert.equal(wilsonLowerBoundBps(5, -1), null);
  assert.equal(wilsonLowerBoundBps(NaN, 5), null);
  assert.equal(wilsonLowerBoundBps(5, Infinity), null);
});

/* ── Classification: refunds are not results ─────────────────────────────── */

function trade(overrides: Partial<AgentTradeRow> = {}): AgentTradeRow {
  return {
    claimId: 1, role: "creator", stake: 2, opposingStake: 2, potentialPayout: 0,
    state: "resolved", winnerSide: "creator", settledAt: NOW,
    category: "crypto", question: "q",
    ...overrides,
  };
}

test("refunds and open positions never count toward the sample", () => {
  const results = [
    ...Array.from({ length: 4 }, (_, i) => classifyTrade(trade({ claimId: i + 1 }))),
    classifyTrade(trade({ claimId: 5, winnerSide: "draw" })),          // refunded
    classifyTrade(trade({ claimId: 6, state: "cancelled" })),          // refunded
    classifyTrade(trade({ claimId: 7, state: "active", winnerSide: "" })), // open
  ];
  const verdict = computeReputation(results);
  // 4 wins, 0 losses: 3 refunds + 1 open add nothing, so the sample is 4 — below
  // the minimum. If a refund had been counted as either a win or a loss, this
  // would have produced a number.
  assert.equal(verdict.decided, 4);
  assert.equal(verdict.sufficient, false);
  assert.equal(verdict.reputationBps, 0);
});

test("computeReputation matches the count-based bound exactly", () => {
  const results = [
    classifyTrade(trade({ claimId: 1 })),
    classifyTrade(trade({ claimId: 2 })),
    classifyTrade(trade({ claimId: 3 })),
    classifyTrade(trade({ claimId: 4 })),
    classifyTrade(trade({ claimId: 5, winnerSide: "challengers" })),
    classifyTrade(trade({ claimId: 6, winnerSide: "challengers" })),
  ];
  const verdict = computeReputation(results);
  assert.equal(verdict.decided, 6);
  assert.equal(verdict.sufficient, true);
  assert.equal(verdict.reputationBps, wilsonLowerBoundBps(4, 2));
});

test("computeReputationFromRows classifies rows the same way", () => {
  const rows = [
    trade({ claimId: 1 }),
    trade({ claimId: 2, winnerSide: "challengers" }),
    trade({ claimId: 3 }),
    trade({ claimId: 4 }),
    trade({ claimId: 5 }),
    trade({ claimId: 6, winnerSide: "challengers" }),
  ];
  assert.deepEqual(computeReputationFromRows(rows), computeReputation(rows.map(classifyTrade)));
});

/* ── Authorization gate: reputation is never authority ───────────────────── */

test("authorizeAction never references reputation — observational only", () => {
  const source = readFileSync(join(process.cwd(), "lib/agents/registry.ts"), "utf8");
  const start = source.indexOf("export function authorizeAction");
  assert.ok(start !== -1, "authorizeAction not found in lib/agents/registry.ts");
  const end = source.indexOf("export function rotateOperator", start);
  assert.ok(end !== -1, "could not bound authorizeAction in lib/agents/registry.ts");
  const gate = source.slice(start, end);
  assert.ok(
    !/reputation/i.test(gate),
    "authorizeAction must not read or branch on reputation; capability plus an owner grant is the only path to authority",
  );
});

/* ── Sync-worker DB write (in-memory fake-pool pattern) ──────────────────── */

interface RecordedQuery { sql: string; args: unknown[] }
const recorded: RecordedQuery[] = [];
let registryRows: Array<Record<string, unknown>> = [];
let creatorRows: Array<Record<string, unknown>> = [];
let challengerRows: Array<Record<string, unknown>> = [];

function installFakePool(): void {
  const record = async (sql: string, args: unknown[] = []) => {
    if (!/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql.trim())) {
      recorded.push({ sql, args });
    }
    if (/FROM\s+agent_registry\s+ORDER BY/i.test(sql)) {
      return { rows: registryRows };
    }
    if (/FROM\s+agent_capabilities/i.test(sql)) {
      return { rows: [] };
    }
    if (/FROM\s+claims\s+c\s+LEFT JOIN/i.test(sql)) {
      // Trade queries bind the address as their only argument; an empty address
      // is the fixture for "nothing readable for this agent".
      return { rows: args[0] ? creatorRows : [] };
    }
    if (/FROM\s+challengers\s+ch\s+JOIN/i.test(sql)) {
      return { rows: args[0] ? challengerRows : [] };
    }
    return { rows: [] as Array<Record<string, unknown>> };
  };

  const pool = {
    query: (sql: string, args: unknown[] = []) => record(sql, args),
    connect: async () => ({
      query: (sql: string, args: unknown[] = []) => record(sql, args),
      release: () => {},
    }),
  };

  process.env.DATABASE_URL = "postgres://fake/mimir";
  const g = globalThis as unknown as Record<string, unknown>;
  g.__mimirDbPool = pool;
  g.__mimirDbReady = Promise.resolve(pool);
}

installFakePool();

function reset(): void {
  recorded.length = 0;
  registryRows = [];
  creatorRows = [];
  challengerRows = [];
}

function registryRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agent_id: "acme-forecaster",
    schema_version: 1,
    owner_wallet: "GBO43ZBS4RBC2QFDKB23U6TBFEEK47ZLGSXDJSRV2H3PNQK5ZDEYXVLE",
    operator_wallet: "GD2SI5PUEFKC7TONNX7OR72WMYUO7WZDSCDSIVWWXPDIDYW5OP3ETM5D",
    payout_wallet: "GCIXSDPXXIJSLEVZSYFCZRNOD6GBFIFKNTEI6X2HC6LE65KUVYMGU4X5",
    display_name: "Acme",
    description: "",
    metadata_uri: null,
    metadata_hash: null,
    authority_level: 3,
    limits_json: "{}",
    status: "active",
    reputation_bps: 0,
    created_at: 1,
    updated_at: 1,
    revoked_at: null,
    revoked_reason: null,
    ...overrides,
  };
}

function settledClaimRow(id: number, winnerSide: string): Record<string, unknown> {
  return {
    id, creator_stake: 2, total_challenger_stake: 2,
    state: "resolved", winner_side: winnerSide,
    settled_at: Math.floor(NOW / 1000), category: "crypto", question: `q${id}`,
  };
}

test("reconcileAgentReputations writes the computed bound with a narrow UPDATE", async () => {
  reset();
  // 4 creator wins, 2 losses — decisive sample of 6, above the floor.
  registryRows = [registryRow({ reputation_bps: 0 })];
  creatorRows = [
    settledClaimRow(1, "creator"),
    settledClaimRow(2, "creator"),
    settledClaimRow(3, "creator"),
    settledClaimRow(4, "creator"),
    settledClaimRow(5, "challengers"),
    settledClaimRow(6, "challengers"),
  ];

  const summary = await reconcileAgentReputations(NOW);
  assert.deepEqual(summary, { scanned: 1, updated: 1 });

  const updates = recorded.filter((q) => /UPDATE\s+agent_registry\s+SET\s+reputation_bps/i.test(q.sql));
  assert.equal(updates.length, 1, "expected exactly one reputation UPDATE");
  const [bps, at, agentId] = updates[0].args;
  assert.equal(bps, wilsonLowerBoundBps(4, 2));
  assert.equal(at, NOW);
  assert.equal(agentId, "acme-forecaster");
  // The write must touch nothing an authorization path reads.
  assert.ok(
    !/authority_level|limits_json|status|capabilities/i.test(updates[0].sql),
    "reputation UPDATE must not touch authority, limits, status or capabilities",
  );
});

test("reconcileAgentReputations is idempotent when the stored value already matches", async () => {
  reset();
  const bps = wilsonLowerBoundBps(4, 2)!;
  registryRows = [registryRow({ reputation_bps: bps })];
  creatorRows = [
    settledClaimRow(1, "creator"),
    settledClaimRow(2, "creator"),
    settledClaimRow(3, "creator"),
    settledClaimRow(4, "creator"),
    settledClaimRow(5, "challengers"),
    settledClaimRow(6, "challengers"),
  ];

  const summary = await reconcileAgentReputations(NOW);
  assert.deepEqual(summary, { scanned: 1, updated: 0 });
  assert.equal(recorded.filter((q) => /UPDATE\s+agent_registry/i.test(q.sql)).length, 0);
});

test("an agent below the sample floor is reset to zero, not left stale", async () => {
  reset();
  registryRows = [registryRow({ reputation_bps: 4_200 })];
  creatorRows = [settledClaimRow(1, "creator"), settledClaimRow(2, "creator")];

  const summary = await reconcileAgentReputations(NOW);
  assert.deepEqual(summary, { scanned: 1, updated: 1 });
  const updates = recorded.filter((q) => /UPDATE\s+agent_registry\s+SET\s+reputation_bps/i.test(q.sql));
  assert.equal(updates[0].args[0], 0);
});

test("an unreadable agent is skipped without aborting the fleet", async () => {
  reset();
  registryRows = [
    registryRow({ agent_id: "broken", operator_wallet: "" }),
    registryRow({ agent_id: "healthy" }),
  ];
  // An empty operator address yields no trade rows — the production shape of
  // "nothing readable for this agent" — while the healthy agent still reconciles.
  creatorRows = [
    settledClaimRow(1, "creator"),
    settledClaimRow(2, "creator"),
    settledClaimRow(3, "creator"),
    settledClaimRow(4, "creator"),
    settledClaimRow(5, "challengers"),
  ];
  const summary = await reconcileAgentReputations(NOW);
  assert.equal(summary.scanned, 2);
  assert.equal(summary.updated, 1);
  const updates = recorded.filter((q) => /UPDATE\s+agent_registry\s+SET\s+reputation_bps/i.test(q.sql));
  assert.equal(updates.length, 1);
  assert.equal(updates[0].args[2], "healthy");
});
