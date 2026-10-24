/**
 * Council evidence cache: one fetch per claim per cycle, a placeholder entry
 * for claims without an http(s) URL, and a hashed failure entry when the
 * fetch throws; across cycles, fresh entries are reused, stale or corrupted
 * ones are refetched, non-joinable claims are evicted and the cache is
 * capped. The fetcher is stubbed and Date is faked, so no network or wall
 * clock is touched.
 */

import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";

import {
  EVIDENCE_CACHE_MAX_ENTRIES,
  clearEvidenceCache,
  evidenceCacheSize,
  getOrFetchEvidence,
  pruneEvidenceCache,
  validateEvidenceIntegrity,
  type EvidenceFetcher,
} from "../../agents/council/shared/evidence-cache";
import { maxAgeForCategory } from "../../agents/council/shared/evidence-freshness";
import type { EvidenceCacheEntry } from "../../agents/council/shared/types";
import { EvidenceFetchError } from "../../lib/server/evidence-fetcher";
import { sha256Hex } from "../../lib/content-hash";

function countingFetcher(impl: EvidenceFetcher): { fetcher: EvidenceFetcher; calls: () => number } {
  let calls = 0;
  const fetcher: EvidenceFetcher = async (url, opts) => {
    calls += 1;
    return impl(url, opts);
  };
  return { fetcher, calls: () => calls };
}

const ok: EvidenceFetcher = async (url) => ({
  sourceUrl: url,
  title: "t",
  text: "the source says yes",
  fetchedAt: 1,
  fetcher: "direct",
});

beforeEach(() => {
  clearEvidenceCache();
});

test("a claim without an http(s) URL yields the 'none' placeholder and no fetch", async () => {
  const { fetcher, calls } = countingFetcher(ok);
  const cache = new Map<number, EvidenceCacheEntry>();
  const entry = await getOrFetchEvidence(1, "ipfs://nope", cache, fetcher);
  assert.equal(entry.fetcher, "none");
  assert.equal(calls(), 0);
  assert.equal(validateEvidenceIntegrity(entry).success, true);
});

test("a fetched entry is cached so the next persona does not refetch", async () => {
  const { fetcher, calls } = countingFetcher(ok);
  const cache = new Map<number, EvidenceCacheEntry>();
  const first = await getOrFetchEvidence(2, "https://example.com/a", cache, fetcher);
  const second = await getOrFetchEvidence(2, "https://example.com/a", cache, fetcher);
  assert.equal(calls(), 1);
  assert.equal(second, first);
  assert.equal(first.text, "the source says yes");
  assert.equal(first.hash, sha256Hex("the source says yes"));
  assert.equal(validateEvidenceIntegrity(first).success, true);
});

test("a fetch error is cached as a hashed failure entry", async () => {
  const { fetcher } = countingFetcher(async () => {
    throw new EvidenceFetchError("blocked");
  });
  const cache = new Map<number, EvidenceCacheEntry>();
  const entry = await getOrFetchEvidence(3, "https://example.com/b", cache, fetcher);
  assert.equal(entry.fetcher, "none");
  assert.equal(entry.text, "(Failed to fetch: blocked)");
  assert.equal(entry.hash, sha256Hex("(Failed to fetch: blocked)"));
  assert.equal(cache.get(3), entry);
});

test("integrity check rejects a tampered entry", () => {
  const entry: EvidenceCacheEntry = { text: "a", fetcher: "direct", hash: sha256Hex("b") };
  assert.equal(validateEvidenceIntegrity(entry).success, false);
});

// ── Cross-cycle persistence ───────────────────────────────────────────────────

/** Like the real fetcher: stamps `fetchedAt` from the (faked) clock. */
const stamped: EvidenceFetcher = async (url) => ({
  sourceUrl: url,
  title: "t",
  text: `evidence for ${url}`,
  fetchedAt: Date.now(),
  fetcher: "direct",
});

const START = 1_700_000_000_000;

test("a claim evaluated in consecutive cycles within its freshness window is fetched once", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: START });
  const { fetcher, calls } = countingFetcher(stamped);
  const url = "https://example.com/btc";

  const first = await getOrFetchEvidence(10, url, new Map(), fetcher, { category: "crypto" });
  t.mock.timers.tick(maxAgeForCategory("crypto") - 1_000);
  const cycle2 = new Map<number, EvidenceCacheEntry>();
  const second = await getOrFetchEvidence(10, url, cycle2, fetcher, { category: "crypto" });

  assert.equal(calls(), 1);
  assert.equal(second, first);
  assert.equal(cycle2.get(10), first, "the reused entry also seeds the new cycle's map");
});

test("a stale entry is refetched on the next cycle", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: START });
  const { fetcher, calls } = countingFetcher(stamped);
  const url = "https://example.com/btc";

  const first = await getOrFetchEvidence(11, url, new Map(), fetcher, { category: "crypto" });
  t.mock.timers.tick(maxAgeForCategory("crypto") + 1_000);
  const second = await getOrFetchEvidence(11, url, new Map(), fetcher, { category: "crypto" });

  assert.equal(calls(), 2);
  assert.notEqual(second, first);
  assert.equal(second.fetchedAt, START + maxAgeForCategory("crypto") + 1_000);
});

test("the freshness window follows the claim's category", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: START });
  const { fetcher, calls } = countingFetcher(stamped);
  // Older than the crypto window, still inside the sports window.
  assert.ok(maxAgeForCategory("crypto") < maxAgeForCategory("sports"));
  await getOrFetchEvidence(12, "https://example.com/c", new Map(), fetcher, { category: "crypto" });
  await getOrFetchEvidence(13, "https://example.com/s", new Map(), fetcher, { category: "sports" });
  t.mock.timers.tick(maxAgeForCategory("crypto") + 1_000);
  await getOrFetchEvidence(12, "https://example.com/c", new Map(), fetcher, { category: "crypto" });
  await getOrFetchEvidence(13, "https://example.com/s", new Map(), fetcher, { category: "sports" });
  assert.equal(calls(), 3, "only the crypto claim is refetched");
});

test("a persisted entry that fails the integrity check is refetched", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: START });
  const { fetcher, calls } = countingFetcher(stamped);
  const url = "https://example.com/tamper";

  const first = await getOrFetchEvidence(14, url, new Map(), fetcher);
  first.text = "tampered";
  const second = await getOrFetchEvidence(14, url, new Map(), fetcher);

  assert.equal(calls(), 2);
  assert.equal(validateEvidenceIntegrity(second).success, true);
});

test("the cache is keyed by claim id and URL", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: START });
  const { fetcher, calls } = countingFetcher(stamped);
  await getOrFetchEvidence(15, "https://example.com/a", new Map(), fetcher);
  const moved = await getOrFetchEvidence(15, "https://example.com/b", new Map(), fetcher);
  assert.equal(calls(), 2, "a changed resolution URL is not served the old URL's evidence");
  assert.equal(moved.text, "evidence for https://example.com/b");
});

test("failed fetches and placeholders are not persisted across cycles", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: START });
  let fail = true;
  const { fetcher, calls } = countingFetcher(async (url, opts) => {
    if (fail) throw new EvidenceFetchError("blocked");
    return stamped(url, opts);
  });
  await getOrFetchEvidence(16, "https://example.com/flaky", new Map(), fetcher);
  await getOrFetchEvidence(17, "ipfs://nope", new Map(), fetcher);
  assert.equal(evidenceCacheSize(), 0);

  fail = false;
  const retried = await getOrFetchEvidence(16, "https://example.com/flaky", new Map(), fetcher);
  assert.equal(calls(), 2);
  assert.equal(retried.fetcher, "direct");
});

test("pruneEvidenceCache evicts claims that are no longer joinable", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: START });
  const { fetcher, calls } = countingFetcher(stamped);
  await getOrFetchEvidence(20, "https://example.com/20", new Map(), fetcher);
  await getOrFetchEvidence(21, "https://example.com/21", new Map(), fetcher);
  assert.equal(evidenceCacheSize(), 2);

  pruneEvidenceCache(new Set([21]));
  assert.equal(evidenceCacheSize(), 1);

  await getOrFetchEvidence(21, "https://example.com/21", new Map(), fetcher);
  await getOrFetchEvidence(20, "https://example.com/20", new Map(), fetcher);
  assert.equal(calls(), 3, "only the evicted claim is refetched");
});

test("the cache is capped and evicts the oldest entries first", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: START });
  const { fetcher, calls } = countingFetcher(stamped);
  const total = EVIDENCE_CACHE_MAX_ENTRIES + 5;
  for (let id = 1; id <= total; id++) {
    await getOrFetchEvidence(id, `https://example.com/${id}`, new Map(), fetcher);
    t.mock.timers.tick(1);
  }
  assert.equal(evidenceCacheSize(), EVIDENCE_CACHE_MAX_ENTRIES);

  // The newest entry is still served from the cache; the oldest was evicted.
  await getOrFetchEvidence(total, `https://example.com/${total}`, new Map(), fetcher);
  assert.equal(calls(), total);
  await getOrFetchEvidence(1, "https://example.com/1", new Map(), fetcher);
  assert.equal(calls(), total + 1);
});
