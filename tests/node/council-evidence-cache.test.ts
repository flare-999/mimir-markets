/**
 * Council evidence cache: one fetch per claim per cycle, a placeholder entry
 * for claims without an http(s) URL, and a hashed failure entry when the
 * fetch throws. The fetcher is stubbed, so no network is touched.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  getOrFetchEvidence,
  validateEvidenceIntegrity,
  type EvidenceFetcher,
} from "../../agents/council/shared/evidence-cache";
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
