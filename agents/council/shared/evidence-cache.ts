/**
 * Evidence cache with cross-cycle persistence and freshness.
 *
 * 10 personas often look at the same claim in a single poll cycle.
 * Without caching, that's 10 HTTP fetches of the same resolution URL
 * per claim per cycle — wasteful and rate-limit-prone.
 *
 * This module maintains a module-level cache keyed by claim id + URL.
 * Entries are reused across cycles while younger than the per-category
 * max age defined in `evidence-freshness.ts`, and evicted once their
 * claim is no longer joinable. The cache is capped to bound memory.
 *
 * The per-cycle Map passed by the runner is still honoured as a
 * cheap first-level lookup, but the module-level cache is the source
 * of truth for cross-cycle reuse.
 */

import { sha256Hex } from "../../../lib/content-hash";
import {
  fetchEvidence as fetchEvidenceShared,
  EvidenceFetchError,
} from "../../../lib/server/evidence-fetcher";
import { maxAgeForCategory } from "./evidence-freshness";
import type { EvidenceCacheEntry } from "./types";

const MAX_CONTENT_CHARS = 8_000;

/** Hard cap on the number of persisted entries. */
const MAX_CACHE_ENTRIES = 500;

/** The fetch used on a cache miss; injectable so tests need no network. */
export type EvidenceFetcher = typeof fetchEvidenceShared;

/** The category type accepted by `maxAgeForCategory`. */
type EvidenceCategory = Parameters<typeof maxAgeForCategory>[0];

/** Result of an integrity check on a cache entry. */
export interface EvidenceIntegrityResult {
  /** True if the entry passed all integrity checks. */
  success: boolean;
  /** Reason for failure, or empty string on success. */
  reason: string;
}

/** An entry stored in the module-level cache. */
interface PersistedEntry {
  claimId: number;
  url: string;
  entry: EvidenceCacheEntry;
}

const persistentCache = new Map<string, PersistedEntry>();

function cacheKey(claimId: number, url: string): string {
  return `${claimId}:${url}`;
}

/**
 * Validate that a cached evidence entry is consistent with its hash and text.
 *
 * This check ensures that:
 * - The hash is a valid SHA-256 hex string (64 hex characters).
 * - The hash matches the actual SHA-256 of the text content.
 * - The text is neither empty nor longer than the fetch cap.
 * - The entry names the fetcher that produced it.
 */
export function validateEvidenceIntegrity(entry: EvidenceCacheEntry): EvidenceIntegrityResult {
  if (!entry.hash || typeof entry.hash !== "string") {
    return { success: false, reason: "missing or invalid hash field" };
  }
  if (!/^[0-9a-fA-F]{64}$/.test(entry.hash)) {
    return { success: false, reason: "invalid hash format - expected 32-byte hex" };
  }
  if (typeof entry.text !== "string") {
    return { success: false, reason: "missing or invalid text field" };
  }
  if (entry.text.length === 0) {
    return { success: false, reason: "evidence text is empty" };
  }
  if (entry.text.length > MAX_CONTENT_CHARS) {
    return { success: false, reason: "evidence text exceeds maximum length" };
  }
  if (sha256Hex(entry.text) !== entry.hash) {
    return { success: false, reason: "hash mismatch - data may be tampered or stale" };
  }
  if (!entry.fetcher || typeof entry.fetcher !== "string") {
    return { success: false, reason: "missing or invalid fetcher field" };
  }
  return { success: true, reason: "" };
}

/** True if the entry is within the freshness window for its category. */
function isFresh(entry: EvidenceCacheEntry, category: EvidenceCategory, now: number): boolean {
  if (typeof entry.fetchedAt !== "number") return false;
  const maxAge = maxAgeForCategory(category);
  return now - entry.fetchedAt < maxAge;
}

/** Evict the oldest entries until the cache is within its cap. */
function enforceCap(): void {
  while (persistentCache.size > MAX_CACHE_ENTRIES) {
    let oldestKey: string | undefined;
    let oldestAt = Infinity;
    for (const [key, value] of persistentCache) {
      const at = typeof value.entry.fetchedAt === "number" ? value.entry.fetchedAt : 0;
      if (at < oldestAt) {
        oldestAt = at;
        oldestKey = key;
      }
    }
    if (oldestKey === undefined) break;
    persistentCache.delete(oldestKey);
  }
}

/**
 * Evict cache entries for claims that are no longer joinable.
 *
 * Call this once per cycle with the set of currently joinable claim ids.
 */
export function evictNonJoinableClaims(joinableClaimIds: ReadonlySet<number>): void {
  for (const [key, value] of persistentCache) {
    if (!joinableClaimIds.has(value.claimId)) {
      persistentCache.delete(key);
    }
  }
}

/** Clear the module-level cache. Intended for tests. */
export function clearEvidenceCache(): void {
  persistentCache.clear();
}

/** Number of entries currently held in the module-level cache. */
export function evidenceCacheSize(): number {
  return persistentCache.size;
}

export async function getOrFetchEvidence(
  claimId: number,
  resolutionUrl: string,
  cache: Map<number, EvidenceCacheEntry>,
  fetcher: EvidenceFetcher = fetchEvidenceShared,
  category?: EvidenceCategory,): Promise<EvidenceCacheEntry> {
  const now = Date.now();
  const key = cacheKey(claimId, resolutionUrl ?? "");

  // First-level: the per-cycle Map.
  const cycleHit = cache.get(claimId);
  if (cycleHit) return cycleHit;

  // Second-level: the module-level cache, validated and fresh.
  const persisted = persistentCache.get(key);
  if (persisted) {
    const integrity = validateEvidenceIntegrity(persisted.entry);
    const fresh =
      category !== undefined ? isFresh(persisted.entry, category, now) : true;
    if (integrity.success && fresh) {
      cache.set(claimId, persisted.entry);
      return persisted.entry;
    }
    // Stale or corrupted - drop it and refetch.
    persistentCache.delete(key);
  }

  if (!resolutionUrl?.startsWith("http")) {
    const empty: EvidenceCacheEntry = {
      text:    "(No resolution URL provided)",
      fetcher: "none",
      hash:    sha256Hex("(No resolution URL provided)"),
    };
    cache.set(claimId, empty);
    return empty;
  }

  try {
    const snap = await fetcher(resolutionUrl, {
      maxChars:  MAX_CONTENT_CHARS,
      userAgent: "Mimir-Council/1.0",
    });
    const entry: EvidenceCacheEntry = {
      text:      snap.text,
      fetcher:   snap.fetcher,
      hash:      sha256Hex(snap.text),
      fetchedAt: snap.fetchedAt,
      sourceUrl: snap.sourceUrl,
    };
    cache.set(claimId, entry);
    // Only persist successful fetches that carry a timestamp.
    if (typeof entry.fetchedAt === "number") {
      persistentCache.set(key, { claimId, url: resolutionUrl, entry });
      enforceCap();
    }
    return entry;
  } catch (err: unknown) {
    const msg =
      err instanceof EvidenceFetchError
        ? err.message
        : err instanceof Error
          ? err.message
          : "unknown";
    const failed: EvidenceCacheEntry = {
      text:    `(Failed to fetch: ${msg})`,
      fetcher: "none",
      hash:    sha256Hex(`(Failed to fetch: ${msg})`),
    };
    cache.set(claimId, failed);
    return failed;
  }
}
