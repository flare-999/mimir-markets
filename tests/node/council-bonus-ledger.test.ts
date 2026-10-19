/**
 * Council Bonus Ledger Tests
 *
 * `lib/council-bonus-ledger.ts` is the at-most-once guard around the oracle's
 * off-contract USDC council bonuses (docs/COUNCIL.md): the payout is reserved
 * in `council_bonus_payouts` before the transfer is submitted, so a restarted
 * worker, a replayed settlement, or a duplicated job can never pay the same
 * juror twice — and a row that already reached a terminal state stays there.
 *
 * The suite installs an in-memory stand-in for that one table on `globalThis`
 * (the fake-pool pattern used by `db-address-fidelity.test.ts` and
 * `proposal-review-queue.test.ts`) before any `getDb()` call, so it needs no
 * database, network access, or credentials and runs unchanged in the default
 * `npm run test:node` tier. The fake interprets the three statements the ledger
 * issues — conflict-free insert, payload lookup, status-guarded update — rather
 * than just recording them, so the assertions below pin real ledger behaviour.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { CouncilBonusKey, CouncilBonusReservation } from "../../lib/council-bonus-ledger";

const NETWORK = "stellar:testnet";
const CONTRACT_ID = "CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR";
const RECIPIENT = "GBO43ZBS4RBC2QFDKB23U6TBFEEK47ZLGSXDJSRV2H3PNQK5ZDEYXVLE";
const OTHER_RECIPIENT = "GD2SI5PUEFKC7TONNX7OR72WMYUO7WZDSCDSIVWWXPDIDYW5OP3ETM5D";
const SETTLEMENT_TX = "a".repeat(64);
const OTHER_SETTLEMENT_TX = "c".repeat(64);
const PAYMENT_TX = "b".repeat(64);
const CLAIM_ID = 4242;
const JUROR_SLUG = "socrates";

// ── in-memory stand-in for council_bonus_payouts ──────────────────────────────

interface LedgerRow {
  network: string;
  contractId: string;
  claimId: number;
  jurorSlug: string;
  recipient: string;
  amountAtomic: string;
  settlementTxHash: string;
  status: string;
  paymentTxHash: string | null;
}

interface RecordedStatement {
  sql: string;
  args: unknown[];
  rowCount: number;
  failed: boolean;
}

const rows = new Map<string, LedgerRow>();
const statements: RecordedStatement[] = [];
let failNextWrite = false;

function rowKey(key: CouncilBonusKey): string {
  return [key.network, key.contractId, key.claimId, key.jurorSlug].join("|");
}

function statementKey(args: unknown[]): CouncilBonusKey {
  return {
    network: args[0] as string,
    contractId: args[1] as string,
    claimId: args[2] as number,
    jurorSlug: args[3] as string,
  };
}

async function dispatch(
  statement: string,
  args: unknown[],
): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number }> {
  if (/^INSERT INTO council_bonus_payouts/i.test(statement)) {
    if (failNextWrite) {
      failNextWrite = false;
      throw new Error("connection terminated unexpectedly");
    }
    const key = statementKey(args);
    if (rows.has(rowKey(key))) return { rows: [], rowCount: 0 };
    rows.set(rowKey(key), {
      network: key.network,
      contractId: key.contractId,
      claimId: key.claimId,
      jurorSlug: key.jurorSlug,
      recipient: args[4] as string,
      amountAtomic: args[5] as string,
      settlementTxHash: args[6] as string,
      status: "reserved",
      paymentTxHash: null,
    });
    return { rows: [{ claim_id: key.claimId }], rowCount: 1 };
  }

  if (/^UPDATE council_bonus_payouts/i.test(statement)) {
    if (failNextWrite) {
      failNextWrite = false;
      throw new Error("connection terminated unexpectedly");
    }
    const row = rows.get(rowKey(statementKey(args)));
    if (!row || row.status !== "reserved") return { rows: [], rowCount: 0 };
    row.status = args[4] as string;
    row.paymentTxHash = args[5] as string | null;
    return { rows: [], rowCount: 1 };
  }

  if (/^SELECT recipient, amount_atomic, settlement_tx_hash/i.test(statement)) {
    const row = rows.get(rowKey(statementKey(args)));
    if (!row) return { rows: [], rowCount: 0 };
    return {
      rows: [{
        recipient: row.recipient,
        amount_atomic: row.amountAtomic,
        settlement_tx_hash: row.settlementTxHash,
      }],
      rowCount: 1,
    };
  }

  throw new Error(`unexpected statement for the council bonus ledger fake: ${statement}`);
}

async function query(sql: string, args: unknown[] = []) {
  const statement = sql.replace(/\s+/g, " ").trim();
  const attempt: RecordedStatement = { sql: statement, args, rowCount: 0, failed: false };
  statements.push(attempt);
  try {
    const result = await dispatch(statement, args);
    attempt.rowCount = result.rowCount;
    return result;
  } catch (error) {
    attempt.failed = true;
    throw error;
  }
}

function installFakePool(): void {
  const pool = {
    query: (sql: string, args: unknown[] = []) => query(sql, args),
    connect: async () => ({
      query: (sql: string, args: unknown[] = []) => query(sql, args),
      release: () => {},
    }),
  };

  process.env.DATABASE_URL = "postgres://fake/mimir";
  // Structurally a Pool only as far as `lib/db` uses one (`query` + `connect`);
  // the global is declared as `Pool`, so the assignment goes through an
  // untyped view. With `__mimirDbReady` preset, `getDb()` never builds a real
  // pool and `ensureSchema` never runs — no socket is ever opened.
  const g = globalThis as unknown as Record<string, unknown>;
  g.__mimirDbPool = pool;
  g.__mimirDbReady = Promise.resolve(pool);
}

installFakePool();

async function ledger() {
  return import("../../lib/council-bonus-ledger");
}

function reservation(overrides: Partial<CouncilBonusReservation> = {}): CouncilBonusReservation {
  return {
    network: NETWORK,
    contractId: CONTRACT_ID,
    claimId: CLAIM_ID,
    jurorSlug: JUROR_SLUG,
    recipient: RECIPIENT,
    amountAtomic: 250_000n,
    settlementTxHash: SETTLEMENT_TX,
    ...overrides,
  };
}

function stored(row: CouncilBonusKey): LedgerRow {
  const found = rows.get(rowKey(row));
  assert.ok(found, "expected a stored council bonus row");
  return found;
}

function matching(pattern: RegExp): RecordedStatement[] {
  return statements.filter((statement) => pattern.test(statement.sql));
}

function reset(): void {
  rows.clear();
  statements.length = 0;
  failNextWrite = false;
}

// ── reservation lifecycle ─────────────────────────────────────────────────────

test("first reservation succeeds and stores the payout as reserved", async () => {
  reset();
  const { reserveCouncilBonus } = await ledger();
  const row = reservation();

  assert.equal(await reserveCouncilBonus(row), true);

  const held = stored(row);
  assert.equal(held.status, "reserved");
  assert.equal(held.recipient, RECIPIENT, "the recipient must be stored verbatim");
  assert.equal(held.amountAtomic, "250000", "the amount must be stored in atomic units");
  assert.equal(held.settlementTxHash, SETTLEMENT_TX);
  assert.equal(held.paymentTxHash, null, "no receipt exists at reservation time");

  const insert = matching(/^INSERT INTO council_bonus_payouts/)[0];
  assert.ok(insert, "the reservation must be written before it is reported as held");
  assert.match(
    insert.sql,
    /ON CONFLICT \(network, contract_id, claim_id, juror_slug\) DO NOTHING/,
    "the insert must be idempotent on the reservation key",
  );
  assert.match(insert.sql, /'reserved', \$8, \$8\)/, "the row must start in the reserved state");
});

test("duplicate reservation is refused without writing a second row", async () => {
  reset();
  const { reserveCouncilBonus } = await ledger();
  const row = reservation();
  assert.equal(await reserveCouncilBonus(row), true);

  assert.equal(
    await reserveCouncilBonus(row),
    false,
    "a replayed reservation must be refused, not paid again",
  );
  assert.equal(rows.size, 1, "the duplicate must not create a second payable row");

  const inserts = matching(/^INSERT INTO council_bonus_payouts/);
  assert.equal(inserts.length, 2, "the duplicate re-attempts the insert and loses the conflict");
  const last = statements[statements.length - 1];
  assert.match(last.sql, /^SELECT recipient/, "the refusal must be verified against the stored payload");
});

test("a reservation retry with a changed recipient, amount, or settlement hash is rejected as conflicting", async () => {
  reset();
  const { reserveCouncilBonus } = await ledger();
  const row = reservation();
  await reserveCouncilBonus(row);

  await assert.rejects(
    () => reserveCouncilBonus(reservation({ recipient: OTHER_RECIPIENT })),
    /conflicting council bonus reservation/,
  );
  await assert.rejects(
    () => reserveCouncilBonus(reservation({ amountAtomic: row.amountAtomic + 1n })),
    /conflicting council bonus reservation/,
  );
  await assert.rejects(
    () => reserveCouncilBonus(reservation({ settlementTxHash: OTHER_SETTLEMENT_TX })),
    /conflicting council bonus reservation/,
  );

  const held = stored(row);
  assert.equal(rows.size, 1, "a conflicting retry must not add a row");
  assert.equal(held.recipient, RECIPIENT, "a conflicting retry must not rewrite the recipient");
  assert.equal(held.amountAtomic, "250000", "a conflicting retry must not rewrite the amount");
  assert.equal(held.settlementTxHash, SETTLEMENT_TX, "a conflicting retry must not rewrite the settlement hash");
});

test("a failed reservation write leaves no row so the attempt can be retried", async () => {
  reset();
  const { reserveCouncilBonus } = await ledger();

  failNextWrite = true;
  await assert.rejects(
    () => reserveCouncilBonus(reservation()),
    /connection terminated unexpectedly/,
  );
  assert.equal(rows.size, 0, "a failed insert must not leave a phantom reservation behind");

  assert.equal(await reserveCouncilBonus(reservation()), true, "the retry must reserve cleanly");
  assert.equal(rows.size, 1);
});

// ── result recording ──────────────────────────────────────────────────────────

test("a failed result write leaves the reservation held so the receipt can be retried", async () => {
  reset();
  const { reserveCouncilBonus, recordCouncilBonusResult } = await ledger();
  const row = reservation();
  await reserveCouncilBonus(row);

  failNextWrite = true;
  await assert.rejects(
    () => recordCouncilBonusResult(row, PAYMENT_TX),
    /connection terminated unexpectedly/,
  );
  assert.equal(stored(row).status, "reserved", "a failed receipt write must not consume the reservation");
  assert.equal(stored(row).paymentTxHash, null, "no receipt may be invented by a failed write");

  assert.equal(
    await reserveCouncilBonus(row),
    false,
    "a held reservation is never payable a second time while its receipt is pending",
  );

  await recordCouncilBonusResult(row, PAYMENT_TX);
  assert.equal(stored(row).status, "confirmed");
  assert.equal(stored(row).paymentTxHash, PAYMENT_TX);
});

test("a confirmed bonus cannot be recorded twice", async () => {
  reset();
  const { reserveCouncilBonus, recordCouncilBonusResult } = await ledger();
  const row = reservation();
  await reserveCouncilBonus(row);
  await recordCouncilBonusResult(row, PAYMENT_TX);

  const update = matching(/^UPDATE council_bonus_payouts/)[0];
  assert.ok(update);
  assert.match(update.sql, /status = 'reserved'$/, "only a held reservation may take a result");

  await assert.rejects(
    () => recordCouncilBonusResult(row, PAYMENT_TX),
    /council bonus reservation was not updated/,
  );
  assert.equal(stored(row).paymentTxHash, PAYMENT_TX, "the original receipt must stay intact");
  assert.equal(stored(row).status, "confirmed");
});

test("a confirmed bonus is never re-reserved for a second transfer", async () => {
  reset();
  const { reserveCouncilBonus, recordCouncilBonusResult } = await ledger();
  const row = reservation();
  await reserveCouncilBonus(row);
  await recordCouncilBonusResult(row, PAYMENT_TX);

  assert.equal(
    await reserveCouncilBonus(row),
    false,
    "success is terminal: a paid bonus must be skipped on any replay",
  );
  const held = stored(row);
  assert.equal(held.status, "confirmed");
  assert.equal(held.paymentTxHash, PAYMENT_TX, "the payment receipt must survive a replay");
  assert.equal(rows.size, 1, "a replay must not add a second payable row");
});

test("a failed payment result is held in review and never re-reserved automatically", async () => {
  reset();
  const { reserveCouncilBonus, recordCouncilBonusResult } = await ledger();
  const row = reservation();
  await reserveCouncilBonus(row);

  await recordCouncilBonusResult(row, null);
  assert.equal(stored(row).status, "review", "an ambiguous transfer must be held for reconciliation");
  assert.equal(stored(row).paymentTxHash, null);

  const update = matching(/^UPDATE council_bonus_payouts/)[0];
  assert.ok(update);
  assert.equal(update.args[4], "review", "a null receipt must bind the review status");
  assert.equal(update.args[5], null);

  assert.equal(
    await reserveCouncilBonus(row),
    false,
    "a held row must never become payable again on a later run",
  );
  assert.equal(stored(row).status, "review", "the row stays where the operator left it");
});

// ── database unavailable ──────────────────────────────────────────────────────

test("an unavailable database fails closed without writing a ledger statement", async () => {
  reset();
  const { reserveCouncilBonus, recordCouncilBonusResult } = await ledger();
  const previous = {
    database: process.env.DATABASE_URL,
    turso: process.env.TURSO_DATABASE_URL,
  };
  delete process.env.DATABASE_URL;
  delete process.env.TURSO_DATABASE_URL;
  try {
    await assert.rejects(
      () => reserveCouncilBonus(reservation()),
      /DATABASE_URL is not configured/,
      "an unconfigured database must withhold the bonus, never report it as reserved",
    );
    await assert.rejects(
      () => recordCouncilBonusResult(reservation(), PAYMENT_TX),
      /DATABASE_URL is not configured/,
    );
    assert.equal(statements.length, 0, "no statement may be attempted against an unconfigured database");
    assert.equal(rows.size, 0, "nothing may be reserved while the ledger is unreachable");
  } finally {
    if (previous.database !== undefined) process.env.DATABASE_URL = previous.database;
    if (previous.turso !== undefined) process.env.TURSO_DATABASE_URL = previous.turso;
  }
});
