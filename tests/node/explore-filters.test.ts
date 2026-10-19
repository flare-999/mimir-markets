import assert from "node:assert/strict";
import test from "node:test";

import type { VSData } from "../../lib/contract";
import {
  applyExploreFilters,
  DEFAULT_EXPLORE_FILTERS,
  parseExploreSearchParams,
  serializeExploreFilters,
} from "../../lib/exploreFilters";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function makeVS(overrides: Partial<VSData> = {}): VSData {
  return {
    id: 1,
    creator: "0x00000000000000000000000000000000000000a1",
    opponent: ZERO_ADDRESS,
    question: "Will BTC close above $100k before next Friday at 23:59 UTC?",
    creator_position: "BTC closes above $100k",
    opponent_position: "BTC stays at or below $100k",
    resolution_url: "https://coingecko.com/en/coins/bitcoin",
    stake_amount: 5,
    deadline: 1_800_086_400,
    state: "open",
    winner: ZERO_ADDRESS,
    resolution_summary: "",
    created_at: 1_799_999_000,
    category: "crypto",
    settlement_rule:
      "Resolve this using the linked source price exactly at the deadline timestamp.",
    challenger_count: 0,
    max_challengers: 3,
    market_type: "binary",
    odds_mode: "pool",
    ...overrides,
  };
}

test("strength sort orders claims by claim quality descending", () => {
  const strong = makeVS({ id: 9 });
  const weak = makeVS({
    id: 3,
    question: "Rain?",
    resolution_url: "",
    settlement_rule: "",
    category: "custom",
    deadline: 1_800_001_000,
  });
  const fair = makeVS({
    id: 5,
    question: "Will ETH break $7k today before midnight UTC?",
    resolution_url: "https://coingecko.com/en/coins/ethereum",
    settlement_rule: "",
    deadline: 1_800_010_000,
  });

  const sorted = applyExploreFilters([fair, weak, strong], {
    ...DEFAULT_EXPLORE_FILTERS,
    sort: "strength",
  });

  assert.deepEqual(
    sorted.map((vs) => vs.id),
    [9, 5, 3]
  );
});

test("needsChallengers filters to claims with fewer than two challengers", () => {
  const filtered = applyExploreFilters(
    [
      makeVS({ id: 1, challenger_count: 0 }),
      makeVS({ id: 2, challenger_count: 1 }),
      makeVS({ id: 3, challenger_count: 2 }),
    ],
    {
      ...DEFAULT_EXPLORE_FILTERS,
      needsChallengers: true,
    }
  );

  assert.deepEqual(
    filtered.map((vs) => vs.id),
    [2, 1]
  );
});

test("expiringSoon filters to deadlines within the next 24 hours only", () => {
  const baseNow = 1_800_000_000;
  const filtered = applyExploreFilters(
    [
      makeVS({ id: 1, deadline: baseNow + 12 * 60 * 60 }),
      makeVS({ id: 2, deadline: baseNow + 30 * 60 * 60 }),
      makeVS({ id: 3, deadline: baseNow - 60 }),
    ],
    {
      ...DEFAULT_EXPLORE_FILTERS,
      expiringSoon: true,
    },
    baseNow
  );

  assert.deepEqual(
    filtered.map((vs) => vs.id),
    [1]
  );
});

test("explore filter URL serialization round-trips new flags", () => {
  const serialized = serializeExploreFilters({
    cat: "crypto",
    minStake: 5,
    sort: "strength",
    search: "btc",
    needsChallengers: true,
    expiringSoon: true,
    participation: "joined",
    underdogOnly: true,
    view: "closed",
  });

  const parsed = parseExploreSearchParams(new URLSearchParams(serialized));

  assert.deepEqual(parsed, {
    cat: "crypto",
    minStake: 5,
    sort: "strength",
    search: "btc",
    needsChallengers: true,
    expiringSoon: true,
    participation: "joined",
    underdogOnly: true,
    view: "closed",
  });
});
