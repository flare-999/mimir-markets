/*
 * Multi-dimensional rate limiting.
 *
 * IP alone is the wrong key for this app. An agent fleet behind one NAT shares an
 * IP, and a single agent can rotate IPs freely — so limiting by ip either punishes
 * honest co-tenants or stops nobody. Every request is therefore counted against
 * several buckets at once:
 *
 *   ip       crude abuse control for anonymous traffic
 *   wallet   a human's writes
 *   agent    a registered agent's calls, the meaningful key for BYOA
 *   route    protects one expensive endpoint from starving the rest
 *
 * The FIRST bucket to exceed its limit refuses the request, and the response says
 * which one — an agent that only ever hears "rate limited" cannot tell whether to
 * slow down or to stop.
 *
 * Fixed windows, deliberately: a sliding window needs per-key timestamp lists, and
 * this is an in-process guard in front of a database that has its own limits. Worst
 * case a caller gets 2x the limit across a window boundary, acceptable for a guard
 * whose job is stopping runaway loops rather than metering billing.
 */

export type LimitDimension = "ip" | "wallet" | "agent" | "route";

export interface LimitRule {
  dimension: LimitDimension;
  /** Requests allowed per window. */
  limit: number;
  windowMs: number;
}

export interface RateLimitKeys {
  ip?: string;
  wallet?: string;
  agentId?: string;
  route?: string;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Which bucket refused. Absent when allowed. */
  exceeded?: LimitDimension;
  /** Seconds until the refusing window resets. */
  retryAfterSeconds?: number;
  /** Remaining allowance in the tightest relevant bucket. */
  remaining: number;
}

export interface BucketState {
  count: number;
  windowStartedAt: number;
}

/**
 * Pluggable backing store for rate-limit windows.
 *
 * The default is in-memory (per-process), which is fine for a single instance
 * but leaks the effective limit across serverless instances. A Postgres-backed
 * store can be enabled via env flag to share counts across instances.
 */
export interface RateLimitStore {
  /** Read a bucket without consuming. Returns null when absent or expired. */
  peek(key: string, windowMs: number, now: number): Promise<BucketState | null>;
  /** Atomically increment the bucket and return the new state. */
  increment(key: string, windowMs: number, now: number): Promise<BucketState>;
  /** Drop expired windows. */
  prune(now: number): Promise<number>;
}

/**
 * Upper bound on simultaneously-stored windows.
 *
 * Buckets are never deleted on expiry — a stale entry is only read as "fresh"
 * again — so distinct keys (mainly IPs) accumulate for the life of the process.
 * A long-lived worker or dev server would otherwise grow the map without bound.
 * The cap is far above real traffic (every live allowance shares one window per
 * key), and eviction only forgets the longest-idle bucket, whose caller just
 * starts a fresh window — the same outcome expiring on its own would produce.
 */
export const MAX_BUCKETS = 10_000;

const buckets = new Map<string, BucketState & { windowMs: number }>();

/** Test and operational seam: inspect how many windows the guard currently holds. */
export function bucketCount(): number {
  return buckets.size;
}

/** Test seam and operational kill switch. */
export function resetRateLimits(): void {
  buckets.clear();
}

export const DEFAULT_RULES: LimitRule[] = [
  { dimension: "ip", limit: 300, windowMs: 60_000 },
  { dimension: "wallet", limit: 120, windowMs: 60_000 },
  { dimension: "agent", limit: 120, windowMs: 60_000 },
  { dimension: "route", limit: 600, windowMs: 60_000 },
];

/**
 * Stricter rules for LLM-backed public routes (claim moderation and claim
 * draft). These endpoints are anonymously reachable once their feature flags
 * are enabled, and each call costs an LLM round trip (and, for drafts, an
 * outbound fetch of an arbitrary source URL), so the generic 300/min IP cap
 * is far too generous. The per-IP cap is the meaningful key here; the route cap
 * keeps one of the two routes from consuming the other's budget.
 */
export const LLM_PUBLIC_RULES: LimitRule[] = [
  { dimension: "ip", limit: 10, windowMs: 60_000 },
  { dimension: "route", limit: 10, windowMs: 60_000 },
];

function keyFor(rule: LimitRule, keys: RateLimitKeys): string | null {
  const value =
    rule.dimension === "ip"
      ? keys.ip
      : rule.dimension === "wallet"
        ? keys.wallet?.toLowerCase()
        : rule.dimension === "agent"
          ? keys.agentId
          : keys.route;
  // A dimension with no value is not counted. Substituting a placeholder would
  // merge every anonymous caller into one shared bucket, so one of them could
  // exhaust the allowance for all.
  return value ? `${rule.dimension}:${value}:${rule.windowMs}` : null;
}

class InMemoryStore implements RateLimitStore {
  async peek(key: string, windowMs: number, now: number): Promise<BucketState | null> {
    const b = buckets.get(key);
    if (!b || now - b.windowStartedAt >= windowMs) return null;
    return { count: b.count, windowStartedAt: b.windowStartedAt };
  }

  async increment(key: string, windowMs: number, now: number): Promise<BucketState> {
    const b = buckets.get(key);
    if (!b || now - b.windowStartedAt >= windowMs) {
      const fresh = { count: 1, windowStartedAt: now, windowMs };
      buckets.set(key, fresh);
      enforceBucketBound(now);
      return { count: fresh.count, windowStartedAt: fresh.windowStartedAt };
    }
    b.count += 1;
    enforceBucketBound(now);
    return { count: b.count, windowStartedAt: b.windowStartedAt };
  }

  async prune(now: number): Promise<number> {
    let removed = 0;
    for (const [key, b] of buckets) {
      if (now - b.windowStartedAt >= b.windowMs) {
        buckets.delete(key);
        removed++;
      }
    }
    return removed;
  }
}

export const inMemoryStore: RateLimitStore = new InMemoryStore();

/** Test seam: swap the active store (pass undefined to restore the default). */
export function setRateLimitStore(store?: RateLimitStore): void {
  activeStore = store ?? inmemoryStore;
  activeStoreIsExplicit = store !== undefined;
}

export function getRateLimitStore(): RateLimitStore {
  return activeStore;
}

let activeStore: RateLimitStore = inMemoryStore;
let activeStoreIsExplicit = false;

/**
 * Resolve the active store from env flags on first use. Tests can override
 * via `setRateLimitStore`. The Postgres store is loaded lazily so the default
 * path has no DB import cost.
 */
async function resolveStore(): Promise<RateLimitStore> {
  if (activeStoreIsExplicit) return activeStore;
  const flag = process.env.RATE_LIMIT_STORE;
  if (flag !== "postgres") return inMemoryStore;
  try {
    const mod = await import("@/lib/server/rate-limit-postgres");
    activeStore = mod.postgresRateLimitStore;
  } catch {
    activeStore = inMemoryStore;
  }
  return activeStore;
}

/**
 * Count a request against every applicable bucket.
 *
 * Consumption happens only when the request is ALLOWED. Charging a refused request
 * would let a caller who is already over the limit keep pushing the window
 * forward, so a single burst could lock a key out indefinitely.
 */
export async function consume(
  keys: RateLimitKeys,
  rules: LimitRule[] = DEFAULT_RULES,
  now = Date.now(),
): Promise<RateLimitDecision> {
  const store = await resolveStore();
  const applicable = rules
    .map((rule) => ({ rule, key: keyFor(rule, keys) }))
    .filter((entry): entry is { rule: LimitRule; key: string } => entry.key !== null);

  let tightestRemaining = Number.POSITIVE_INFINITY;

  // First pass: would any bucket be exceeded?
  for (const { rule, key } of applicable) {
    const bucket = await store.peek(key, rule.windowMs, now);
    const count = bucket?.count ?? 0;
    if (count >= rule.limit) {
      const windowStart = bucket?.windowStartedAt ?? now;
      const resetsAt = windowStart + rule.windowMs;
      return {
        allowed: false,
        exceeded: rule.dimension,
        retryAfterSeconds: Math.max(1, Math.ceil((resetsAt - now) / 1000)),
        remaining: 0,
      };
    }
    tightestRemaining = Math.min(tightestRemaining, rule.limit - count - 1);
  }

  // Second pass: commit, now that nothing is over.
  for (const { rule, key } of applicable) {
    await store.increment(key, rule.windowMs, now);
  }

  return {
    allowed: true,
    remaining: tightestRemaining === Number.POSITIVE_INFINITY ? 0 : tightestRemaining,
  };
}

/**
 * Keep the window map inside {@link MAX_BUCKETS}. Expired windows are dropped
 * first (they are dead memory by definition); if the map is still over the cap,
 * the longest-idle live bucket is forgotten — it resets just as its own window
 * expiring would. Not run for refused requests: those are not committed to a
 * bucket, so they cannot grow the map.
 */
function enforceBucketBound(now: number): void {
  if (buckets.size <= MAX_BUCKETS) return;
  for (const [key, bucket] of buckets) {
    if (now - bucket.windowStartedAt >= bucket.windowMs) {
      buckets.delete(key);
      if (buckets.size <= MAX_BUCKETS) return;
    }
  }
  while (buckets.size > MAX_BUCKETS) {
    // Insertion-ordered: the first key is the oldest window.
    const oldest = buckets.keys().next().value;
    if (oldest === undefined) break;
    buckets.delete(oldest);
  }
}

/** Inspect without consuming, for a status endpoint. */
export async function peek(
  keys: RateLimitKeys,
  rules: LimitRule[] = DEFAULT_RULES,
  now = Date.now(),
): Promise<Record<string, { used: number; limit: number; resetsInSeconds: number }>> {
  const store = await resolveStore();
  const out: Record<string, { used: number; limit: number; resetsInSeconds: number }> = {};
  for (const rule of rules) {
    const key = keyFor(rule, keys);
    if (!key) continue;
    const bucket = await store.peek(key, rule.windowMs, now);
    out[rule.dimension] = {
      used: bucket?.count ?? 0,
      limit: rule.limit,
      resetsInSeconds: bucket
        ? Math.max(0, Math.ceil((bucket.windowStarted + rule.windowMs - now) / 1000))
        : Math.ceil(rule.windowMs / 1000),
    };
  }
  return out;
}

/** Prune expired windows from the active store. */
export async function pruneRateLimits(now = Date.now()): Promise<number> {
  const store = await resolveStore();
  return store.prune(now);
}
