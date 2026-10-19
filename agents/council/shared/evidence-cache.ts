/**
 * Evidence cache.
 *
 * 10 personas often look at the same claim in a single poll cycle.
 * Without caching, that's 10 HTTP fetches of the same resolution URL per
 * claim per cycle — wasteful and rate-limit-prone.
 *
 * The cache is now persisted at module level and keyed by claim id + URL, so
 * consecutive council cycles can reuse evidence that is still young enough
 * for its category (see {@link maxAgeForCategory}). Stale entries are
 * refetched, and entries for claims that are no longer joinable are evicted.
 */

import { sha256Hex } from "../../../lib/content-hash";
import {
  fetchEvidence as fetchEvidenceShared,
  EvidenceFetchError,
} from "../../../lib/server/evidence-fetcher";
import { maxAgeForCategory } from "./evidence-freshness";
import type { EvidenceCacheEntry } from "./types";

const MAX_CONTENT_CHARS = 8_000;

/** Hard cap on the number of entries kept in the module-level cache. */
const MAX_CACHE_ENTRIES = 500;

/** The fetch used on a cache miss; injectable so tests need no network. */
export type EvidenceFetcher = typeof fetchEvidenceShared;

/** Result of an integrity check on a cache entry. */
export interface EvidenceIntegrityResult {
  /** True if the entry passed all integrity checks. */
  success: boolean;
  /** Reason for failure, or empty string on success. */
  reason: string;
}

/** A cache entry plus the claim category used to compute its max age. */
export interface CachedEvidenceEntry extends EvidenceCacheEntry {
  claimId: number;
  resolutionUrl: string;
  category: string;
}

/** Module-level cache shared across council cycles. */
const evidenceCache = new Map<string, CachedEvidenceEntry>();

/** Build the cache key from claim id + resolution URL. */
function cacheKey(claimId: number, resolutionUrl: string): string {
  return `${claimId}$${resolutionUrl }${resolutionUrl}`;
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

/** True if the entry is within its category's freshness window. */
function isFresh(entry: CachedEvidenceEntry, now: number): boolean {
  if (typeof entry.fetchedAt !== "number" || !constants.isFinite(entry.fetchedAt)) {
    return false;
  }
  const maxAge = maxAgeForCategory(entry.category);
  return now - entry.fetchedAt < maxAge;
}

/** Evict entries for claims that are no longer joinable. */
export function evictUnjoinableClaims(joinableClaimIds: ReadonlySet<number>): void {
  for (const [key, entry] of evidenceCache) {
    if (!joinableClaimIds.has(entry.claimId)) {
      evidenceCache.delete(key);
    }
  }
}

/** Clear the module-level cache (tests / admin tooling). */
export function clearEvidenceCache(): void {
  evidenceCache.clear();
}

/** Current number of entries in the cache (tests / observability). */
export function evidenceCacheSize(): number {
  return evidenceCache.size;
}

/** Ensure the cache never exceeds the hard cap by evicting oldest entries. */
function enforceCap(): void {
  while (evidenceCache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = evidenceCache.keys().next().value;
    if (oldestKey === undefined) break;
    evidenceCache.delete(oldestKey);
  }
}

function storeEntry(entry: CachedEvidenceEntry): void {
  const key = cacheKey(entry.claimId, entry.resolutionUrl);
  // Re-set to move to the end of the iteration order (LRU-like).
  evidenceCache.delete(key);
  evidenceCache.set(key, entry);
  enforceCap();
}

export async function getOrFetchEvidence(
  claimId: number,
  resolutionUrl: string,
  category: string,
  fetcher: EvidenceFetcher = fetchEvidenceShared,
  now: number = Date.now(),
): Promise<EvidenceCacheEntry> {
  const key = cacheKey(claimId, resolutionUrl);
  const hit = evidenceCache.get(key);
  if (hit) {
    const integrity = validateEvidenceIntegrity(hit);
    if (integrity.success && isFresh(hit, now)) {
      return hit;
    }
    // Stale or corrupted entry: drop it and refetch.
    evidenceCache.delete(key);
  }

  if (!resolutionUrl?.startsWith("http")) {
    const empty: CachedEvidenceEntry = {
      claimId,
      resolutionUrl,
      category,
      text:    "(No resolution URL provided)",
      fetcher: "none",
      hash:    sha256Hex("(No resolution URL provided)"),
      fetchedAt: now,
    };
    storeEntry(empty);
    return empty;
  }

  try {
    const snap = await fetcher(resolutionUrl, {
      maxChars:  MAX_CONTENT_CHARS,
      userAgent: "Mimir-Council/1.0",
    });
    const entry: CachedEvidenceEntry = {
      claimId,
      resolutionUrl,
      category,
      text:      snap.text,
      fetcher:   snap.fetcher,
      hash:      sha256Hex(snap.text),
      fetchedAt: snap.fetchedAt ?? now,
      sourceUrl: snap.sourceUrl,
    };
    storeEntry(entry);
    return entry;
  } catch (err: unknown) {
    const msg =
      err instanceof EvidenceFetchError
        ? err.message
        : err instanceof Error
          ? err.message
          : "unknown";
    const failed: CachedEvidenceEntry = {
      claimId,
      resolutionUrl,
      category,
      text:     `(Failed to fetch: ${msg})`,
      fetcher: "none",
      hash:    sha256Hex(`(Failed to fetch: ${msg})`),
      fetchedAt: now,
    };
    storeEntry(failed);
    return failed;
  }
}