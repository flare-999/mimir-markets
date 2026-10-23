import assert from "node:assert/strict";
import test from "node:test";

import {
  buildComparisonData,
  MAX_COMPARE_IDS,
  parseCompareIds,
  type ComparisonAgent,
} from "../../lib/agents/comparison";
import { classifyTrade, computeAgentPerformance, type AgentTradeRow } from "../../lib/agents/performance";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

function trade(overrides: Partial<AgentTradeRow> = {}): AgentTradeRow {
  return {
    claimId: 1,
    role: "creator",
    stake: 2,
    opposingStake: 2,
    potentialPayout: 0,
    state: "resolved",
    winnerSide: "creator",
    settledAt: NOW - HOUR,
    category: "crypto",
    question: "q",
    ...overrides,
  };
}

function makeAgent(id: string, rows: AgentTradeRow[]): ComparisonAgent {
  const { performance } = computeAgentPerformance(rows);
  return {
    id,
    displayName: id,
    emoji: "🤖",
    description: "",
    track: "byoa",
    address: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    performance,
    // Newest first, the way the page receives them.
    results: rows.map(classifyTrade).sort((a, b) => b.claimId - a.claimId),
  };
}

test("a comma list is trimmed, empties dropped and duplicates collapsed", () => {
  assert.deepEqual(parseCompareIds("a, b ,,c"), ["a", "b", "c"]);
  assert.deepEqual(parseCompareIds("a,a,b"), ["a", "b"]);
  // Repeated param: the first one wins, like every other searchParam here.
  assert.deepEqual(parseCompareIds(["x,y", "z"]), ["x", "y"]);
  assert.deepEqual(parseCompareIds(undefined), []);
  assert.deepEqual(parseCompareIds(""), []);
});

test("the comparison is capped at three ids", () => {
  assert.equal(MAX_COMPARE_IDS, 3);
  const ids = parseCompareIds("a,b,c,d,e");
  assert.ok(ids.length > MAX_COMPARE_IDS, "the fixture must overshoot the cap");
  assert.deepEqual(ids.slice(0, MAX_COMPARE_IDS), ["a", "b", "c"]);
});

test("buildComparisonData builds one series per agent, order preserved", () => {
  const a1 = makeAgent("a1", [
    trade({ claimId: 1, stake: 2, opposingStake: 2, winnerSide: "creator", settledAt: NOW - 2 * HOUR }),
  ]);
  const a2 = makeAgent("a2", [
    trade({ claimId: 1, stake: 2, opposingStake: 2, winnerSide: "creator", settledAt: NOW - 2 * HOUR }),
    trade({ claimId: 2, stake: 2, winnerSide: "challengers", settledAt: NOW - HOUR }),
  ]);

  const data = buildComparisonData([a1, a2], { nowMs: NOW, window: "all" });

  assert.deepEqual(data.agents.map((agent) => agent.id), ["a1", "a2"]);
  assert.deepEqual(data.series.map((entry) => entry.agent.id), ["a1", "a2"]);
  assert.equal(data.series[0].points.length, 1, "a1 settled once");
  assert.equal(data.series[1].points.length, 2, "a2 settled twice");

  // Cumulative USDC: a1 ends at +2. a2 won 2 then lost 2, so it ends flat at 0.
  assert.deepEqual(
    data.series[0].points.map((point) => point.value),
    [2],
  );
  assert.deepEqual(
    data.series[1].points.map((point) => point.value),
    [2, 0],
  );
  assert.equal(data.series[1].points[0].timestamp, NOW - 2 * HOUR);
  assert.equal(data.series[1].points[1].timestamp, NOW - HOUR);
});

test("a window clips every series at the same boundary", () => {
  const old = makeAgent("old", [
    trade({ claimId: 1, settledAt: NOW - 40 * HOUR, winnerSide: "creator", stake: 2, opposingStake: 2 }),
  ]);
  const fresh = makeAgent("fresh", [
    trade({ claimId: 1, settledAt: NOW - 2 * HOUR, winnerSide: "challengers", stake: 3 }),
  ]);

  const day = buildComparisonData([old, fresh], { nowMs: NOW, window: "24h" });
  assert.equal(day.series[0].points.length, 0, "the 40h-old settlement falls outside 24h");
  assert.equal(day.series[1].points.length, 1);
  assert.deepEqual(day.series[1].points.map((point) => point.value), [-3]);

  const all = buildComparisonData([old, fresh], { nowMs: NOW, window: "all" });
  assert.equal(all.series[0].points.length, 1, "all-time has no lower bound");
  assert.equal(all.series[1].points.length, 1);
});

test("an agent with no settled results contributes an empty series, not a crash", () => {
  const idle = makeAgent("idle", [trade({ state: "active", winnerSide: "", settledAt: 0 })]);
  const busy = makeAgent("busy", [
    trade({ claimId: 1, settledAt: NOW - HOUR, winnerSide: "creator", stake: 2, opposingStake: 2 }),
  ]);

  const data = buildComparisonData([idle, busy], { nowMs: NOW, window: "all" });
  assert.equal(data.series[0].points.length, 0, "an open stake has no P&L to plot");
  assert.equal(data.series[1].points.length, 1, "the busy agent still charts");

  const empty = buildComparisonData([], { nowMs: NOW });
  assert.deepEqual(empty.agents, []);
  assert.deepEqual(empty.series, []);
});
