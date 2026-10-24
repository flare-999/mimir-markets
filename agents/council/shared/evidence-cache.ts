/**
 * Council evidence cache: per cycle, and across cycles while fresh.
 *
 * 10 personas often look at the same claim in a single poll cycle.
 * Without caching, that's 10 HTTP fetches of the same resolution URL
 * per claim per cycle — wasteful and rate-limit-prone.
 *
 * Two levels:
 *  - The runner builds a per-cycle Map and the LLM evaluators ask it
 *    before doing a fetch.
 *  - Successful fetches are also kept in a module-level cache keyed by
 *    claim id + URL, so the next cycle reuses them instead of refetching
 *    (fetching can hit paid sources). An entry is reused only while it is
 *    inside `maxAgeForCategory(category)` (the same gate
 *    `checkEvidenceFreshness` applies before a vote) and still passes
 *    `validateEvidenceIntegrity`; otherwise it is dropped and refetched.
 *    `pruneEvidenceCache` evicts claims that are no longer joinable, and
 *    the cache is capped at `EVIDENCE_CACHE_MAX_ENTRIES` (oldest first).
 *
 * Placeholder and failed-fetch entries carry no `fetchedAt` and are never
 * persisted, so a failure is retried on the next cycle.
 */

import { sha256Hex } from "../../../lib/content-hash";
import {
  fetchEvidence as fetchEvidenceShared,
  EvidenceFetchError,
} from "../../../lib/server/evidence-fetcher";
import { checkEvidenceFreshness } from "./evidence-freshness";
import type { EvidenceCacheEntry } from "./types";

const MAX_CONTENT_CHARS = 8_000;

/** Upper bound on cross-cycle entries, so a long-running worker stays bounded. */
export const EVIDENCE_CACHE_MAX_ENTRIES = 500;

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

interface PersistedEvidence {
  claimId: number;
  entry:   EvidenceCacheEntry;
}

/**
 * Cross-cycle cache keyed by `${claimId}:${url}`. Map iteration order is
 * insertion order, and an entry is re-inserted on every refetch, so the
 * first key is always the oldest fetch.
 */
const persistentCache = new Map<string, PersistedEvidence>();

function persistentKey(claimId: number, url: string): string {
  return `${claimId}:${url}`;
}

function persist(key: string, claimId: number, entry: EvidenceCacheEntry): void {
  persistentCache.delete(key);
  persistentCache.set(key, { claimId, entry });
  while (persistentCache.size > EVIDENCE_CACHE_MAX_ENTRIES) {
    const oldest = persistentCache.keys().next().value;
    if (oldest === undefined) break;
    persistentCache.delete(oldest);
  }
}

/**
 * Evict cross-cycle entries for claims that are no longer joinable.
 * The council calls this once per poll with the cycle's joinable claim ids.
 */
export function pruneEvidenceCache(joinableClaimIds: ReadonlySet<number>): void {
  for (const [key, value] of persistentCache) {
    if (!joinableClaimIds.has(value.claimId)) persistentCache.delete(key);
  }
}

/** Number of cross-cycle entries currently held. */
export function evidenceCacheSize(): number {
  return persistentCache.size;
}

/** Drop every cross-cycle entry. Test helper. */
export function clearEvidenceCache(): void {
  persistentCache.clear();
}

export interface GetOrFetchEvidenceOptions {
  /** The claim's category; selects the freshness window for reuse. */
  category?: string | null;
  /** Epoch ms reference for the freshness check (defaults to `Date.now()`). */
  now?: number;
}

export async function getOrFetchEvidence(
  claimId: number,
  resolutionUrl: string,
  cache: Map<number, EvidenceCacheEntry>,
  fetcher: EvidenceFetcher = fetchEvidenceShared,
  options: GetOrFetchEvidenceOptions = {},
): Promise<EvidenceCacheEntry> {
  const hit = cache.get(claimId);
  if (hit) return hit;

  const key = persistentKey(claimId, resolutionUrl ?? "");
  const persisted = persistentCache.get(key);
  if (persisted) {
    const fresh = checkEvidenceFreshness(
      persisted.entry,
      options.category,
      options.now ?? Date.now(),
    ).fresh;
    if (fresh && validateEvidenceIntegrity(persisted.entry).success) {
      cache.set(claimId, persisted.entry);
      return persisted.entry;
    }
    // Stale or failed the integrity check: drop it and refetch below.
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
    // Only real fetches carry a timestamp; without one freshness is unknowable.
    if (typeof entry.fetchedAt === "number") persist(key, claimId, entry);
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
