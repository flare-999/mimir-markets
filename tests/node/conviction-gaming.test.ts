import assert from "node:assert/strict";
import test from "node:test";

import { buildLeaderboard, positionsFromProjection, type LeaderboardInput } from "../../lib/leaderboard";
import { STAKE_CAP_USDC, scorePosition, stakeFactor, type Outcome, type ScoredPosition } from "../../lib/scoring";
import { unitsToUsdc, usdcToUnits } from "../../lib/usdc";

/**
 * §6.7's gaming tests: sybil splitting, late entry, micro-stake spam and
 * self-created markets. Each is a way to score without forecasting, and each has
 * to be shown not to work.
 */

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
    openedAt: T0,
    enteredAt: T0,
    deadlineAt: T0 + 10 * DAY,
    resolvedAt: T0 + 10 * DAY,
    category: "crypto",
    sideShareBpsAtEntry: 5_000,
    ...overrides,
  };
}

function actor(address: string, positions: ScoredPosition[]): LeaderboardInput {
  return { address, actorType: "human", positions };
}

// ── Micro-stake spam ──────────────────────────────────────────────────────────

test("winning many tiny markets does not outrank winning a few real ones", () => {
  // Per-position scores are capped at 1 but a SUM has no ceiling, so 100 wins of
  // 0.50 USDC would beat three considered positions. Ranking on the mean is what
  // stops that.
  const spammer = actor(
    "0xspam",
    Array.from({ length: 100 }, (_, i) => position(i + 1, "win", { stakeUsdc: 0.5 })),
  );
  const forecaster = actor(
    "0xreal",
    [1, 2, 3].map((id) => position(id, "win", { stakeUsdc: 50 })),
  );
  const board = buildLeaderboard([spammer, forecaster]);
  assert.equal(board.ranked[0].address, "0xreal");
});

test("the spammer's raw total is still larger, which is why it is not the key", () => {
  // Documents the actual trade-off rather than pretending the sum is fine.
  const spammer = actor(
    "0xspam",
    Array.from({ length: 100 }, (_, i) => position(i + 1, "win", { stakeUsdc: 0.5 })),
  );
  const forecaster = actor("0xreal", [1, 2, 3].map((id) => position(id, "win", { stakeUsdc: 50 })));
  const board = buildLeaderboard([spammer, forecaster]);
  const spam = [...board.ranked, ...board.unranked].find((e) => e.address === "0xspam")!;
  const real = board.ranked.find((e) => e.address === "0xreal")!;
  assert.ok(spam.convictionScore > real.convictionScore);
  assert.ok(spam.convictionPerPosition < real.convictionPerPosition);
});

test("a dust stake earns close to nothing per position", () => {
  assert.ok(stakeFactor(0.01) < 0.05);
  assert.equal(stakeFactor(0), 0);
  assert.equal(stakeFactor(-5), 0);
});

// ── Buying rank ───────────────────────────────────────────────────────────────

test("stake weight is capped, so a whale cannot buy the top spot", () => {
  assert.equal(stakeFactor(STAKE_CAP_USDC), 1);
  assert.equal(stakeFactor(STAKE_CAP_USDC * 1_000), 1);
});

test("doubling a stake does not double the score", () => {
  const small = scorePosition(position(1, "win", { stakeUsdc: 10 })).score;
  const double = scorePosition(position(1, "win", { stakeUsdc: 20 })).score;
  assert.ok(double > small);
  assert.ok(double < small * 2);
});

// ── Sybil splitting ───────────────────────────────────────────────────────────

test("splitting a stake across wallets does not pool into one better record", () => {
  // Ten wallets of 10 USDC each score separately; none of them reaches what the
  // single 100 USDC position scores per position, and there is no identity that
  // adds them up.
  const whole = buildLeaderboard(
    [actor("0xone", [1, 2, 3].map((id) => position(id, "win", { stakeUsdc: 100 })))],
    { minResolved: 1 },
  ).ranked[0];
  const split = buildLeaderboard(
    Array.from({ length: 10 }, (_, i) =>
      actor(`0xsybil${i}`, [1, 2, 3].map((id) => position(id, "win", { stakeUsdc: 10 }))),
    ),
    { minResolved: 1 },
  );
  for (const entry of split.ranked) {
    assert.ok(
      entry.convictionPerPosition < whole.convictionPerPosition,
      `${entry.address} matched the undivided stake`,
    );
  }
});

test("a sybil cannot beat the qualifying floor by spreading positions thinner", () => {
  // Each wallet needs its own decisive results; splitting one history across ten
  // wallets leaves every one of them unranked.
  const split = buildLeaderboard(
    Array.from({ length: 10 }, (_, i) => actor(`0xsybil${i}`, [position(i + 1, "win")])),
  );
  assert.equal(split.ranked.length, 0);
  assert.equal(split.unranked.length, 10);
});

// ── Late entry ────────────────────────────────────────────────────────────────

test("a position taken just before the deadline scores near zero", () => {
  // By then the outcome is usually obvious, so it is not a forecast.
  const early = scorePosition(position(1, "win", { enteredAt: T0 })).score;
  const late = scorePosition(
    position(1, "win", { enteredAt: T0 + 10 * DAY - 60_000 }),
  ).score;
  assert.ok(late < early * 0.01);
});

test("a position taken after the deadline scores zero, not a negative", () => {
  const factors = scorePosition(position(1, "win", { enteredAt: T0 + 20 * DAY }));
  assert.equal(factors.timeFactor, 0);
  assert.equal(factors.score, 0);
});

test("an early loss costs more than a late one", () => {
  // Symmetry matters: if lateness only reduced gains, the optimal play would be to
  // enter late always.
  const earlyLoss = scorePosition(position(1, "loss", { enteredAt: T0 })).score;
  const lateLoss = scorePosition(
    position(1, "loss", { enteredAt: T0 + 9 * DAY }),
  ).score;
  assert.ok(earlyLoss < lateLoss);
  assert.ok(earlyLoss < 0);
});

test("a zero-length market cannot be farmed for a perfect timing score", () => {
  // deadline == opened would otherwise divide by zero or read as "maximally early".
  const factors = scorePosition(position(1, "win", { openedAt: T0, deadlineAt: T0 }));
  assert.equal(factors.timeFactor, 0);
  assert.equal(factors.score, 0);
});

// ── Self-created markets ──────────────────────────────────────────────────────

const SELF = "0x00000000000000000000000000000000000000ff";
const OTHER = "0x00000000000000000000000000000000000000ee";

function projected(challengers: Array<{ address: string; stakeUnits: bigint }>) {
  return {
    claimId: 1,
    creator: SELF,
    category: "crypto",
    state: "resolved" as const,
    winnerSide: 2,
    challengers,
    totalChallengerStakeUnits: challengers.reduce((sum, c) => sum + c.stakeUnits, 0n),
  };
}

test("standing on both sides of your own market scores nothing", () => {
  // It costs nothing — the creator loses exactly what the challenger wins — but
  // would register a win whose factors need not cancel the paired loss.
  const inputs = positionsFromProjection({
    claims: [projected([{ address: SELF, stakeUnits: usdcToUnits(10) }])],
    creatorStakeUnitsFor: () => usdcToUnits(10),
    stakeToUsdc: unitsToUsdc,
  });
  const self = inputs.find((i) => i.address === SELF)!;
  assert.equal(self.positions.length, 0);
  assert.equal(self.selfDealtClaims, 1);
});

test("the exclusion is counted, not silently filtered", () => {
  const inputs = positionsFromProjection({
    claims: [projected([{ address: SELF, stakeUnits: usdcToUnits(10) }])],
    creatorStakeUnitsFor: () => usdcToUnits(10),
    stakeToUsdc: unitsToUsdc,
  });
  const board = buildLeaderboard(inputs, { minResolved: 1 });
  const entry = [...board.ranked, ...board.unranked].find((e) => e.address === SELF)!;
  assert.equal(entry.selfDealtClaims, 1);
  assert.equal(entry.resolvedCount, 0);
});

test("a genuine counterparty on a self-dealt claim still counts", () => {
  // The creator's wash trade must not erase somebody else's real position.
  const inputs = positionsFromProjection({
    claims: [
      projected([
        { address: SELF, stakeUnits: usdcToUnits(10) },
        { address: OTHER, stakeUnits: usdcToUnits(10) },
      ]),
    ],
    creatorStakeUnitsFor: () => usdcToUnits(10),
    stakeToUsdc: unitsToUsdc,
  });
  const other = inputs.find((i) => i.address === OTHER)!;
  assert.equal(other.positions.length, 1);
  assert.equal(other.positions[0].outcome, "win");
});

test("a self-challenge with the exact creator address is caught", () => {
  // Addresses compare exactly: a Stellar strkey is case-sensitive base32.
  const inputs = positionsFromProjection({
    claims: [projected([{ address: SELF, stakeUnits: usdcToUnits(10) }])],
    creatorStakeUnitsFor: () => usdcToUnits(10),
    stakeToUsdc: unitsToUsdc,
  });
  const self = inputs.find((i) => i.address === SELF)!;
  assert.equal(self.selfDealtClaims, 1);
  assert.equal(self.positions.length, 0);
});

test("a normal market is unaffected by the self-deal check", () => {
  const inputs = positionsFromProjection({
    claims: [projected([{ address: OTHER, stakeUnits: usdcToUnits(10) }])],
    creatorStakeUnitsFor: () => usdcToUnits(10),
    stakeToUsdc: unitsToUsdc,
  });
  const creator = inputs.find((i) => i.address === SELF)!;
  const other = inputs.find((i) => i.address === OTHER)!;
  assert.equal(creator.selfDealtClaims, 0);
  assert.equal(creator.positions.length, 1);
  assert.equal(creator.positions[0].outcome, "loss");
  assert.equal(other.positions[0].outcome, "win");
});
