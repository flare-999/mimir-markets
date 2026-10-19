export type VSCacheFreshnessSource = "index" | "contract";
export type VSCacheFreshnessStatus = "live" | "cached" | "stale";

export interface VSCacheFreshness {
  source: VSCacheFreshnessSource;
  status: VSCacheFreshnessStatus;
  lastUpdatedAt: string | null;
  ageMs: number | null;
  freshnessWindowMs: number;
}

const STALE_MULTIPLIER = 5;

export function buildVSCacheFreshness(args: {
  updatedAtMs?: number | null;
  freshnessWindowMs: number;
  source: VSCacheFreshnessSource;
}): VSCacheFreshness {
  const updatedAtMs =
    typeof args.updatedAtMs === "number" && Number.isFinite(args.updatedAtMs)
      ? args.updatedAtMs
      : null;
  const ageMs = updatedAtMs == null ? null : Math.max(0, Date.now() - updatedAtMs);

  let status: VSCacheFreshnessStatus = "stale";
  if (ageMs != null) {
    if (ageMs <= args.freshnessWindowMs) {
      status = "live";
    } else if (ageMs <= args.freshnessWindowMs * STALE_MULTIPLIER) {
      status = "cached";
    }
  }

  return {
    source: args.source,
    status,
    lastUpdatedAt: updatedAtMs == null ? null : new Date(updatedAtMs).toISOString(),
    ageMs,
    freshnessWindowMs: args.freshnessWindowMs,
  };
}

export function makeContractFreshness(): VSCacheFreshness {
  return buildVSCacheFreshness({
    updatedAtMs: Date.now(),
    freshnessWindowMs: 1,
    source: "contract",
  });
}

// A warning applies only to indexed reads, never to an on-chain snapshot.
export function isStaleIndexSnapshot(
  freshness: VSCacheFreshness | null,
  nowMs = Date.now()
): boolean {
  if (!freshness || freshness.source !== "index") return false;
  if (freshness.status === "stale") return true;

  const updatedAtMs = freshness.lastUpdatedAt
    ? Date.parse(freshness.lastUpdatedAt)
    : NaN;
  if (
    !Number.isFinite(updatedAtMs) ||
    !Number.isFinite(freshness.freshnessWindowMs) ||
    freshness.freshnessWindowMs <= 0
  ) {
    return true;
  }

  return nowMs - updatedAtMs > freshness.freshnessWindowMs * STALE_MULTIPLIER;
}

/**
 * Compute a weak ETag for the public VS feed from its max `updated_at`
 * and item count. Returns null when there is no usable validator data.
 */
export function buildVsFeedEtag(args: {
  maxUpdatedAt?: string | null;
  itemCount?: number | null;
}): string | null {
  const itemCount =
    typeof args.itemCount === "number" && Number.isFinite(args.itemCount)
      ? Math.max(0, Math.floor(args.itemCount))
      : null;
  if (itemCount == null) return null;

  const maxUpdatedAt =
    typeof args.maxUpdatedAt === "string" && args.maxUpdatedAt.trim() !== ""
      ? args.maxUpdatedAt.trim()
      : null;
  if (maxUpdatedAt == null) return null;

  // Weak ETag: semantically equivalent, byte-identity not required.
  return `W/"${maxUpdatedAt}:${itemCount}"`;
}
