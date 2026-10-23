/**
 * Mimir Read-Index Sync Worker
 *
 * Reconciles the Neon read index against on-chain state. Contract state is the
 * source of truth; this keeps /explorer, /dashboard and the VS APIs from serving
 * stale claims, and it is the `sync` worker /api/health monitors.
 *
 * Lives in the worker fleet rather than behind a platform cron: Railway already
 * runs this fleet as a long-lived process, so an in-process interval needs no
 * scheduler, no HTTP hop and no shared secret to go wrong.
 *
 * Read-only: this worker signs nothing. Everything it needs comes from Soroban RPC
 * through `lib/contract.ts` (claims) and `lib/stellar.ts` (`getEvents`, for the
 * settlement projection), so it needs no keypair and holds no secret.
 *
 * Run: npx tsx agents/sync/index.ts
 * Env: DATABASE_URL, NEXT_PUBLIC_STELLAR_MARKET_CONTRACT_ID,
 *      NEXT_PUBLIC_STELLAR_RPC_URL
 *      SYNC_POLL_INTERVAL_MS=300000 (poll cadence in ms, default 5m)
 *      SYNC_POLL_JITTER_MS=30000    (± spread per cycle, default 10%; 0 = fixed)
 */

import { fileURLToPath } from "node:url";
import path from "node:path";

import { getMarketContractId, getStellarRpcUrl } from "../../lib/stellar";
import { reportingPoll, runWorkerLoop } from "../../lib/ops/heartbeat";
import { resolvePollJitterMs } from "../../lib/ops/poll-jitter";
import { reconcileSettlements } from "../../lib/server/settlement-index";
import { reconcileVsIndex } from "../../lib/server/vs-index";
import { reconcileAgentReputations } from "../../lib/agents/reputation";
import {
  BackoffError,
  DependencyFailureError,
  StaleStateError,
  SYNC_BACKOFF,
  describeBackoffError,
  withBackoff,
} from "../../lib/ops/backoff-policies";

// Default 5m: the health probe warns when the index is over 300s stale, so a
// slower cadence would report a working sync as degraded.
const POLL_INTERVAL_MS = Number(process.env.SYNC_POLL_INTERVAL_MS ?? "300000");
// ± around each cycle; unset = 10% of the interval, 0 = fixed scheduling.
const POLL_JITTER_MS = resolvePollJitterMs(POLL_INTERVAL_MS, process.env.SYNC_POLL_JITTER_MS);

export interface SettlementDrainSummary {
  passes: number;
  settlements: number;
  accruals: number;
  payouts: number;
  claims: number;
  fromLedger: number;
  toLedger: number;
  truncated: boolean;
  stoppedReason?: "completed" | "max_passes" | "time_budget";
}

export interface DrainSettlementsOptions {
  maxPasses?: number;
  timeBudgetMs?: number;
  now?: () => number;
  log?: (message: string) => void;
}

/**
 * Loop reconcileSettlements() while truncated is true, up to a configurable
 * max iterations/time budget per cycle (SYNC_MAX_SETTLEMENT_PASSES).
 *
 * Catches up faster after downtime by draining multiple capped ledger slices in
 * a single sync cycle rather than waiting a full SYNC_POLL_INTERVAL_MS between slices.
 */
export async function drainSettlements(
  reconciler: () => Promise<SettlementSyncResult | null | undefined>,
  options?: DrainSettlementsOptions,
): Promise<SettlementDrainSummary | null> {
  const configuredMax = Number(process.env.SYNC_MAX_SETTLEMENT_PASSES ?? "10");
  const maxPasses =
    options?.maxPasses ??
    (Number.isFinite(configuredMax) && configuredMax > 0 ? Math.floor(configuredMax) : 10);
  const timeBudgetMs =
    options?.timeBudgetMs ??
    (process.env.SYNC_SETTLEMENT_TIME_BUDGET_MS
      ? Number(process.env.SYNC_SETTLEMENT_TIME_BUDGET_MS)
      : undefined);
  const now = options?.now ?? (() => Date.now());
  const log = options?.log ?? console.log;

  const startTime = now();
  let passes = 0;
  let totalSettlements = 0;
  let totalAccruals = 0;
  let totalPayouts = 0;
  let totalClaims = 0;
  let firstFromLedger = 0;
  let lastToLedger = 0;
  let isTruncated = false;
  let stoppedReason: "completed" | "max_passes" | "time_budget" = "completed";

  while (passes < maxPasses) {
    if (timeBudgetMs !== undefined && passes > 0 && now() - startTime >= timeBudgetMs) {
      stoppedReason = "time_budget";
      break;
    }

    const fees = await reconciler();
    if (!fees || typeof fees !== "object") {
      if (passes === 0) return null;
      break;
    }

    passes += 1;
    if (passes === 1) {
      firstFromLedger = fees.fromLedger;
    }
    lastToLedger = fees.toLedger;
    totalSettlements += fees.settlements;
    totalAccruals += fees.accruals;
    totalPayouts += fees.payouts;
    totalClaims += fees.claims;
    isTruncated = Boolean(fees.truncated);

    if (!isTruncated) {
      stoppedReason = "completed";
      break;
    }

    if (passes >= maxPasses) {
      stoppedReason = "max_passes";
      break;
    }

    if (timeBudgetMs !== undefined && now() - startTime >= timeBudgetMs) {
      stoppedReason = "time_budget";
      break;
    }
  }

  if (passes === 0) return null;

  const summary: SettlementDrainSummary = {
    passes,
    settlements: totalSettlements,
    accruals: totalAccruals,
    payouts: totalPayouts,
    claims: totalClaims,
    fromLedger: firstFromLedger,
    toLedger: lastToLedger,
    truncated: isTruncated,
    stoppedReason,
  };

  log(
    `[sync]    settlements: ${summary.passes} pass(es) · ${summary.settlements} market(s), ` +
      `${summary.accruals} accrual(s), ${summary.payouts} pull payout(s), ${summary.claims} fee claim(s) · ` +
      `ledgers ${summary.fromLedger}→${summary.toLedger}${summary.truncated ? " (truncated — will resume)" : ""}`,
  );

  return summary;
}

async function poll(): Promise<void> {
  let rawSummary: unknown;
  try {
    rawSummary = await withBackoff("sync", () => reconcileVsIndex(), { policy: SYNC_BACKOFF });
  } catch (err) {
    if (err instanceof BackoffError) {
      console.warn(`[sync] ${describeBackoffError(err)}`);
      return;
    }
    throw err;
  }
  if (!rawSummary || typeof rawSummary !== "object") return;
  const summary = rawSummary as { synced: number; new: number; stateChanges: number };
  console.log(
    `[sync] ── Reconciled at ${new Date().toISOString()} — ` +
      `${summary.synced} synced, ${summary.new} new, ${summary.stateChanges} state change(s)`,
  );

  try {
    await drainSettlements(async () => {
      const res = await withBackoff("sync", () => reconcileSettlements(), { policy: SYNC_BACKOFF });
      return res as SettlementSyncResult | null | undefined;
    });
  } catch (err) {
    if (err instanceof BackoffError) {
      console.warn(`[sync] ${describeBackoffError(err)}`);
      return;
    }
    throw err;
  }
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required — the read index has nowhere to live");
  }

  console.log("═══════════════════════════════════════════════");
  console.log("  Mimir Read-Index Sync Worker");
  console.log(`  Contract   : ${getMarketContractId() || "(unset)"}`);
  console.log(`  Soroban RPC: ${getStellarRpcUrl()}`);
  console.log(`  Poll every : ${POLL_INTERVAL_MS / 1000}s`);
  console.log(`  Poll jitter: ±${(POLL_JITTER_MS / 1000).toFixed(1)}s`);
  console.log("═══════════════════════════════════════════════\n");

  // Reports a heartbeat either way, so a crash-looping sync shows as alive and
  // failing on /api/health rather than merely stale.
  const safePoll = () => reportingPoll("sync", "sync", POLL_INTERVAL_MS / 1000, poll);

  await runWorkerLoop({
    worker: "sync",
    intervalMs: POLL_INTERVAL_MS,
    jitterMs: POLL_JITTER_MS,
    cycle: safePoll,
  });
}

const isMain = Boolean(process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]));

if (isMain) {
  main().catch((err) => {
    console.error("[sync] Fatal:", err);
    process.exit(1);
  });
}
