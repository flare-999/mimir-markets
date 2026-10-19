/**
 * Evidence cache.
 *
 * 10 personas often look at the same claim in a single poll cycle.
 * Without caching, that's 10 HTTP fetches of the same resolution URL per claim per cycle — wasteful and rate-limit-prone.
 *
 * The cache is module-level so it persists across council cycles. Entries are
 * keyed by claim id + resolution URL and carry a `fetchedAt` timestamp. An entry
 * is reused only while it is younger than `maxAgeForCategory(category)` and passes
 * `integrity validation. Entries for claims that are no longer joinable are evicted,
 * and the cache is capped to bound memory.
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

/** Key for the module-level cache: claim id + resolution URL. */
export function evidenceCacheKey(claimId: number, resolutionUrl: string): string {
  return `${claimId}:${resolutionUrl ?? ""}`;
}

/** Module-level cache shared across council cycles. */
const evidenceCache = new Map<string, EvidenceCacheEntry>();

/** Return the shared cache (for tests / inspection). */
export function getEvidenceCache(): Map<string, EvidenceCacheEntry> {
  return evidenceCache;
}

/** Clear the shared cache (tests / shutdown). */
export function clearEvidenceCache(): void {
  evidenceCache.clear();
}

/** Evict cache entries for claims that are no longer joinable. */
export function evictNonJoinableClaims(joinableClaimIds: ReadonlySet<number>): void {
  for (const key of evidenceCache.keys()) {
    const claimId = Number(key.slice(0, key.indexOf(":")));
    if (!Number.isFinite(claimId) || !joinableClaimIds.has(claimId)) {
      evidenceCache.delete(key);
    }
  }
}

/** Drop the oldest entries once the cache exceeds its cap. */
function enforceCap(): void {
  if (evidenceCache.size <= MAX_CACHE_ENTRIES) return;
  const excess = evidenceCache.size - MAX_CACHE_ENTRIES;
  let dropped = 0;
  for (const key of evidenceCache.keys()) {
    evidenceCache.delete(key);
    if (++dropped >= excess) break;
  }
}

/** True if the entry is within its category's freshness window. */
export function isFresh(
  entry: EvidenceCacheEntry,
  category: string,
  now: number = Date.now(),
): boolean {
  if (typeof entry.fetchedAt !== "number" || !Number.isFinite(entry.fetchedAt)) {
    return false;
  }
  const maxAge = maxAgeForCategory(category);
  if (typeof maxAge !== "number" || !Number.isFinite(maxAge) || maxAge <= 0) {
    return false;
  }
  return now - entry.fetchedAt < maxAge;
}

export async function getOrFetchEvidence(
  claimId: number,
  resolutionUrl: string,
  category: string,
  fetcher: EvidenceFetcher = fetchEvidenceShared,
): Promise<EvidenceCacheEntry> {
  const key = evidenceCacheKey(claimId, resolutionUrl);
  const hit = evidenceCache.get(key);
  if (hit) {
    if (isFresh(hit, category) && validateEvidenceIntegrity(hit).success) {
      return hit;
    }
    evidenceCache.delete(key);
  }

  if (!resolutionUrl?.startsWith("http")) {
    const text = "(No resolution URL provided)";
    const empty: EvidenceCacheEntry = {
      text,
      fetcher: "none",
      hash: sha256Hex(text),
      fetchedAt: Date.now(),
      sourceUrl: resolutionUrl,
    };
    evidenceCache.set(key, empty);
    enforceCap();
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
      fetchedAt: snap.fetchedAt ?? Date.now(),
      sourceUrl: snap.sourceUrl,
    };
    evidenceCache.set(key, entry);
    enforceCap();
    return entry;
  } catch (err: unknown) {
    const msg =
      err instanceof EvidenceFetchError
        ? err.message
        : err instanceof Error
          ? err.message
          : "unknown";
    const text = `(Failed to fetch: ${msg})`;
    const failed: EvidenceCacheEntry = {
      text,
      fetcher: "none",
      hash: sha256Hex(text),
      fetchedAt: Date.now(),
      sourceUrl: resolutionUrl,
    };
    evidenceCache.set(key, failed);
    enforceCap();
    return failed;
  }
}
