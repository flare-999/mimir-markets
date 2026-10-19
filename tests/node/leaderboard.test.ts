import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_MIN_RESOLVED,
  buildLeaderboard,
  splitByActorType,
  streakBadge,
  type LeaderboardInput,
} from "../../lib/leaderboard";
import type { Outcome, ScoredPosition } from "../../lib/scoring";

const DAY = 86_400_000;
const T0 = 1_800_000_000_000;

function position(
  claimId: number,
  outcome: Outcome,
  overrides: Partial<ScoredPosition> = {},
): ScoredPosition {
  return {
    claimId,
    outcome,
    stakeUsdc: 10,
    resolvedAt: T0 + claimId * DAY,
    enteredAt: T0 - DAY,
    openedAt: T0 - 2 * DAY,
    deadlineAt: T0 + claimId * DAY,
    category: "crypto",
    ...overrides,
  };
}

function actor(
  address: string,
  outcomes: Outcome[],
  overrides: Partial<LeaderboardInput> = {},
): LeaderboardInput {
  return {
    address,
    actorType: "human",
    positions: outcomes.map((outcome, index) => position(index + 1, outcome)),
    ...overrides,
  };
}

// ── Determinism ───────────────────────────────────────────────────────────────

test("the same history always produces the same order", () => {
  // A leaderboard that reorders between two rebuilds is not a leaderboard.
  const inputs = [
    actor("0xaa", ["win", "win", "win"]),
    actor("0xbb", ["win", "win", "win"]),
    actor("0xcc", ["win", "loss", "win"]),
  ];
  const first = buildLeaderboard(inputs).ranked.map((e) => e.address);
  const second = buildLeaderboard([...inputs].reverse()).ranked.map((e) => e.address);
  assert.deepEqual(first, second);
});

test("an exact tie breaks on address, not on insertion order", () => {
  const board = buildLeaderboard([
    actor("0xbb", ["win", "win", "win"]),
    actor("0xaa", ["win", "win", "win"]),
  ]);
  assert.deepEqual(board.ranked.map((e) => e.address), ["0xaa", "0xbb"]);
});

test("addresses are kept verbatim: Stellar strkeys are case-sensitive", () => {
  const board = buildLeaderboard([actor("GAABB", ["win", "win", "win"])]);
  assert.equal(board.ranked[0].address, "GAABB");
});

// ── Refunds ───────────────────────────────────────────────────────────────────

test("a refund neither breaks a streak nor counts as a result", () => {
  // A user who staked, drew, and staked again has not stopped being right.
  const board = buildLeaderboard([actor("0xaa", ["win", "refund", "win"])], { minResolved: 1 });
  const entry = board.ranked[0];
  assert.equal(entry.currentStreak, 2);
  assert.equal(entry.wins, 2);
  assert.equal(entry.losses, 0);
  assert.equal(entry.refunds, 1);
  assert.equal(entry.winRateBps, 10_000);
});

test("a refund moves realized PnL by zero", () => {
  // All-refund actors are unranked: refunds are not decisive results, so they
  // never reach the qualifying floor however many there are.
  const board = buildLeaderboard([actor("0xaa", ["refund", "refund", "refund"])], { minResolved: 1 });
  assert.equal(board.ranked.length, 0);
  assert.equal(board.unranked[0].realizedPnlUsdc, 0);
  assert.equal(board.unranked[0].refunds, 3);
});

test("a loss is a real negative result, not an omission", () => {
  const board = buildLeaderboard([actor("0xaa", ["loss", "loss", "loss"])]);
  const entry = board.ranked[0];
  assert.equal(entry.losses, 3);
  assert.equal(entry.winRateBps, 0);
  assert.ok(entry.realizedPnlUsdc < 0);
});

test("a pending position does not count toward anything", () => {
  const board = buildLeaderboard([actor("0xaa", ["win", "pending", "pending"])], { minResolved: 1 });
  assert.equal(board.ranked[0].resolvedCount, 1);
});

// ── Qualification ─────────────────────────────────────────────────────────────

test("one lucky win does not top the table", () => {
  // Without a floor, a 100% win rate off a single result rewards not playing.
  const board = buildLeaderboard([
    actor("0xlucky", ["win"]),
    actor("0xsteady", ["win", "win", "loss", "win"]),
  ]);
  assert.deepEqual(board.ranked.map((e) => e.address), ["0xsteady"]);
  assert.deepEqual(board.unranked.map((e) => e.address), ["0xlucky"]);
});

test("the qualifying threshold is reported so the UI can explain it", () => {
  assert.equal(buildLeaderboard([]).minResolved, DEFAULT_MIN_RESOLVED);
  assert.equal(buildLeaderboard([], { minResolved: 10 }).minResolved, 10);
});

test("an actor who has only refunded is unranked rather than last", () => {
  // It has not played, which is different from having played and lost.
  const board = buildLeaderboard([actor("0xaa", ["refund", "refund", "refund"])]);
  assert.equal(board.ranked.length, 0);
  assert.equal(board.unranked.length, 1);
});

// ── Category and actor type ───────────────────────────────────────────────────

test("a category filter counts only that category's positions", () => {
  const input: LeaderboardInput = {
    address: "0xaa",
    actorType: "human",
    positions: [
      position(1, "win", { category: "crypto" }),
      position(2, "win", { category: "crypto" }),
      position(3, "loss", { category: "sports" }),
    ],
  };
  const crypto = buildLeaderboard([input], { category: "crypto", minResolved: 1 }).ranked[0];
  assert.equal(crypto.resolvedCount, 2);
  assert.equal(crypto.winRateBps, 10_000);
  const sports = buildLeaderboard([input], { category: "sports", minResolved: 1 }).ranked[0];
  assert.equal(sports.winRateBps, 0);
});

test("the category filter is case-insensitive", () => {
  const input = actor("0xaa", ["win", "win", "win"]);
  assert.equal(buildLeaderboard([input], { category: "CRYPTO" }).ranked.length, 1);
});

test("agents and humans are ranked in separate tables", () => {
  // An agent staking every hour out-volumes any person, so one merged table is
  // just a list of agents.
  const boards = splitByActorType([
    actor("0xhuman", ["win", "win", "win"]),
    actor("0xagent", ["win", "win", "win", "win", "win"], { actorType: "agent" }),
  ]);
  assert.deepEqual(boards.human.ranked.map((e) => e.address), ["0xhuman"]);
  assert.deepEqual(boards.agent.ranked.map((e) => e.address), ["0xagent"]);
});

// ── Sorting ───────────────────────────────────────────────────────────────────

test("sorting by win rate puts the higher rate first", () => {
  const board = buildLeaderboard(
    [actor("0xaa", ["win", "loss", "win"]), actor("0xbb", ["win", "win", "win"])],
    { sortBy: "winRate" },
  );
  assert.equal(board.ranked[0].address, "0xbb");
});

test("sorting by volume puts the busier actor first", () => {
  const board = buildLeaderboard(
    [actor("0xaa", ["win", "win", "win"]), actor("0xbb", ["win", "win", "win", "loss", "loss"])],
    { sortBy: "volume" },
  );
  assert.equal(board.ranked[0].address, "0xbb");
});

test("sorting by streak puts the current run first", () => {
  const board = buildLeaderboard(
    [actor("0xaa", ["win", "win", "loss"]), actor("0xbb", ["loss", "win", "win"])],
    { sortBy: "streak" },
  );
  assert.equal(board.ranked[0].address, "0xbb");
});

// ── Streak badge language ─────────────────────────────────────────────────────

test("a zero streak has no badge", () => {
  // Only an actor with no decisive result at all has a zero streak — a refund
  // after a loss leaves the loss run standing rather than clearing it.
  const entry = buildLeaderboard([actor("0xaa", ["refund", "refund"])], { minResolved: 1 })
    .unranked[0];
  assert.equal(entry.currentStreak, 0);
  assert.equal(streakBadge(entry).tone, "none");
});

test("a refund does not clear a run in either direction", () => {
  const afterLoss = buildLeaderboard([actor("0xaa", ["win", "loss", "refund"])], { minResolved: 1 })
    .ranked[0];
  assert.equal(streakBadge(afterLoss).tone, "losing");
  const afterWin = buildLeaderboard([actor("0xbb", ["loss", "win", "refund"])], { minResolved: 1 })
    .ranked[0];
  assert.equal(streakBadge(afterWin).tone, "winning");
});

test("the badge carries direction in the tone and a positive magnitude", () => {
  const winning = buildLeaderboard([actor("0xaa", ["win", "win", "win"])]).ranked[0];
  assert.deepEqual(streakBadge(winning), { tone: "winning", length: 3, isPersonalBest: true });
  const losing = buildLeaderboard([actor("0xbb", ["loss", "loss", "loss"])]).ranked[0];
  const badge = streakBadge(losing);
  assert.equal(badge.tone, "losing");
  assert.equal(badge.length, 3);
});

test("a losing run is never a personal best", () => {
  // The badge would otherwise read as an achievement.
  const losing = buildLeaderboard([actor("0xbb", ["loss", "loss", "loss", "loss"])]).ranked[0];
  assert.equal(streakBadge(losing).isPersonalBest, false);
});

test("a run shorter than the actor's best is not flagged as a best", () => {
  const entry = buildLeaderboard([actor("0xaa", ["win", "win", "win", "loss", "win"])], {
    minResolved: 1,
  }).ranked[0];
  const badge = streakBadge(entry);
  assert.equal(badge.tone, "winning");
  assert.equal(badge.length, 1);
  assert.equal(badge.isPersonalBest, false);
});

// ── Early backer marker (§6.7) ────────────────────────────────────────────────

test("an early minority-side position is marked", () => {
  const board = buildLeaderboard(
    [
      {
        address: "0xaa",
        actorType: "human",
        positions: [
          position(1, "win", { sideShareBpsAtEntry: 1_000, enteredAt: T0 - 2 * DAY }),
          position(2, "win", { sideShareBpsAtEntry: 9_000 }),
          position(3, "win", { sideShareBpsAtEntry: 5_000 }),
        ],
      },
    ],
    { minResolved: 1 },
  );
  assert.ok(board.ranked[0].earlyUnderdogCount >= 1);
});
