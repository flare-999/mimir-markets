/**
 * Evidence cache for the council.
 *
 * 10 personas often look at the same claim in a single poll cycle.
 * Without caching, that's 10 HTTP fetches of the same resolution URL
 * per claim per cycle — wasteful and rate-limit-prone.
 *
 * The runner builds one of these per cycle and the LLM evaluators ask
 * it before doing a fetch.
 *
 * The cache is also backed by a module-level store (keyed by claim id
 * + URL) so evidence fetched in a previous cycle can be reused within
 * its per-category freshness window (`maxAgeForCategory`). Entries are
 * validated with `validateEvidenceIntegrity` before reuse and the
 * store is capped to keep memory bounded.
 */

import { sha256Hex } from "../../../lib/content-hash";
import {
  fetchEvidence as fetchEvidenceShared,
  EvidenceFetchError,
} from "../../../lib/server/evidence-fetcher";
import { maxAgeForCategory } from "./evidence-freshness";
import type { EvidenceCacheEntry } from "./types";

const MAX_CONTENT_CHARS = 8_000;

/** Maximum number of entries kept in the module-level cache. */
export const MAX_CACHE_ENTRIES = 500;

/** The fetch used on a cache miss; injectable so tests need no network. */
export type EvidenceFetcher = typeof fetchEvidenceShared;

/** Result of an integrity check on a cache entry. */
export interface EvidenceIntegrityResult {
  /** True if the entry passed all integrity checks. */
  success: boolean;
  /** Reason for failure, or empty string on success. */
  reason: string;
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

/** A module-level cache entry, keyed by claim id + URL. */
export interface PersistedEvidenceEntry {
  claimId: number;
  url: string;
  entry: EvidenceCacheEntry;
  /** Epoch milliseconds when the entry was stored. */
  fetchedAt: number;
  /** Category used to determine the freshness window. */
  category: string;
}

/** Module-level cache shared across council cycles. */
const persistedCache = new Map<string, PersistedEvidenceEntry>();

function cacheKey(claimId: number, url: string): string {
  return `${claimId}$${url}`;
}

/**
 * Return the current number of entries in the module-level cache.
 */
export function persistedCacheSize(): number {
  return persistedCache.size;
}

/** Clear the module-level cache (used by tests). */
export function clearPersistedCache(): void {
  persistedCache.clear();
}

/**
 * Evict cache entries for claims that are no longer joinable.
 */
export function evictUnjoinableClaims(joinableClaimIds: ReadonlySet<number>): void {
  for (const [key, entry] of persistedCache) {
    if (!joinableClaimIds.has(entry.claimId)) {
      persistedCache.delete(key);
    }
  }
}

/** Evict the oldest entries until the cap is met. */
function enforceCap(): void {
  while (persistedCache.size > MAX_CACHE_ENTRIES) {
    let oldestKey: string | undefined;
    let oldestAt = Infinity;
    for (const [key, entry] of persistedCache) {
      if (entry.fetchedAt < oldestAt) {
        oldestAt = entry.fetchedAt;
        oldestKey = key;
      }
    }
    if (oldestKey === undefined) break;
    persistedCache.delete(oldestKey);
  }
}

/** Return true if the entry is within its category freshness window. */
function isFresh(entry: PersistedEvidenceEntry, now: number): boolean {
  const maxAge = maxAgeForCategory(entry.category);
  if (!Number.isFinite(maxAge) || maxAge <= 0) return false;
  return now - entry.fetchedAt < maxAge;
}

/**
 * Look up a fresh, integrity-validated entry from the module-level cache.
 * Returns undefined on miss, stale, or integrity failure.
 */
export function getPersistedEvidence(
  claimId: number,
  url: string,
  category: string,
  now: number = Date.now(),
): EvidenceCacheEntry | undefined {
  const key = cacheKey(claimId, url);
  const cached = persistedCache.get(key);
  if (!cached) return undefined;
  if (cached.category !== category) return undefined;
  if (!isFresh(cached, now)) {
    persistedCache.delete(key);
    return undefined;
  }
  const integrity = validateEvidenceIntegrity(cached.entry);
  if (!integrity.success) {
    persistedCache.delete(key);
    return undefined;
  }
  return cached.entry;
}

/** Store an evidence entry in the module-level cache. */
export function setPersistedEvidence(
  claimId: number,
  url: string,
  category: string,
  entry: EvidenceCacheEntry,
  now: number = Date.now(),
): void {
  persistedCache.set(cacheKey(claimId, url), {
    claimId,
    url,
    entry,
    fetchedAt: now,
    category,
  });
  enforceCap();
}

export async function getOrFetchEvidence(
  claimId: number,
  resolutionUrl: string,
  cache: Map<number, EvidenceCacheEntry>,
  fetcher: EvidenceFetcher = fetchEvidenceShared,
  category: string = "default",
): Promise<EvidenceCacheEntry> {
  const hit = cache.get(claimId);
  if (hit) return hit;

  const now = Date.now();
  const persisted = getPersistedEvidence(claimId, resolutionUrl, category, now);
  if (persisted) {
    cache.set(claimId, persisted);
    return persisted;
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
    setPersistedEvidence(claimId, resolutionUrl, category, entry, now);
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
