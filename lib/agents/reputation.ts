/**
 * Observational agent reputation — the Wilson score lower bound of an agent's
 * win rate over settled, decisive positions.
 *
 * The invariant that shapes everything here: **reputation is display, never
 * authority.** `authorizeAction` in `lib/agents/registry.ts` has no reference to
 * `reputationBps` and a grep-pinned regression test keeps it that way. Nothing
 * in this module may move money, gate a capability or adjust a fee.
 *
 * The formula is a pure, stateless function of (wins, losses), so wiping the
 * read index and rebuilding from chain events reproduces the identical number —
 * the same rebuildability ADR 0001 demands of conviction. See
 * `docs/adr/0003-observational-reputation-v1.md`.
 */

import { classifyTrade, type AgentTradeResult, type AgentTradeRow } from "./performance";
import { getAgentTradeRows, listAgentRecords, updateAgentReputationBps } from "@/lib/db";

/**
 * Versioned because the formula WILL change, and a stored reputation that
 * silently changes its meaning is worse than one that admits a new version.
 */
export const REPUTATION_VERSION = 1;

/**
 * Below this many decisive settlements there is no number — only "insufficient
 * history". Five is the smallest sample at which the Wilson lower bound can
 * separate a lucky streak from a coin flip at 95% confidence.
 */
export const MIN_REPUTATION_DECIDED = 5;

/** 95% two-sided z. The one constant the formula has, and it is standard. */
const Z_95 = 1.96;

export interface ReputationVerdict {
  /** Stored value: bps when the sample is sufficient, 0 otherwise. */
  reputationBps: number;
  /** Decisive settled positions backing the number. */
  decided: number;
  sufficient: boolean;
}

/**
 * Wilson score lower bound, in basis points.
 *
 *   lower = (phat + z²/2n − z · √(phat(1−phat)/n + z²/4n²)) / (1 + z²/n)
 *
 * A point win rate would rank a 1–0 agent above a 90–30 one; the lower bound
 * does not, and it can only rise when a win lands and only fall when a loss does.
 *
 * Pure integer-count input, no rows: the caller classifies positions once and
 * this function stays trivially fixture-testable.
 */
export function wilsonLowerBoundBps(wins: number, losses: number): number | null {
  const decided = wins + losses;
  if (!Number.isFinite(wins) || !Number.isFinite(losses) || wins < 0 || losses < 0) return null;
  if (decided < MIN_REPUTATION_DECIDED) return null;
  const n = decided;
  const phat = wins / n;
  const z2 = Z_95 * Z_95;
  const denom = 1 + z2 / n;
  const centre = (phat + z2 / (2 * n)) / denom;
  const margin = (Z_95 * Math.sqrt((phat * (1 - phat)) / n + z2 / (4 * n * n))) / denom;
  const lower = centre - margin;
  const bps = Math.round(lower * 10_000);
  return Math.max(0, Math.min(10_000, bps));
}

/**
 * Reputation from classified trade results.
 *
 * Refunds are excluded — a draw, an unresolvable outcome or a cancellation is
 * an ambiguity that was not the agent's doing, so it is neither a win nor a
 * loss. Same rule as conviction (ADR 0001): a refund is not a result.
 */
export function computeReputation(results: readonly AgentTradeResult[]): ReputationVerdict {
  let wins = 0;
  let losses = 0;
  for (const result of results) {
    if (result.outcome === "won") wins += 1;
    else if (result.outcome === "lost") losses += 1;
  }
  const decided = wins + losses;
  const bps = wilsonLowerBoundBps(wins, losses);
  return {
    reputationBps: bps ?? 0,
    decided,
    sufficient: bps !== null,
  };
}

/** Convenience for callers holding raw rows rather than classified results. */
export function computeReputationFromRows(rows: readonly AgentTradeRow[]): ReputationVerdict {
  return computeReputation(rows.map(classifyTrade));
}

/**
 * Recompute and store reputation for every registry agent.
 *
 * Runs in the sync worker after settlement reconciliation, so the stored value
 * always describes the latest settled outcomes. Writes are narrow: one UPDATE
 * of `reputation_bps` + `updated_at` per agent whose value actually moved, and
 * never capabilities, limits or status.
 *
 * A single agent's unreadable trade history must not abort the fleet: the query
 * swallows the error and leaves that agent's stored value untouched, which is
 * safe because the value is observational — a stale number on a profile page is
 * a display bug, not a wrong authorization.
 */
export async function reconcileAgentReputations(now = Date.now()): Promise<{ scanned: number; updated: number }> {
  const records = await listAgentRecords(200);
  let updated = 0;
  for (const record of records) {
    let bps: number;
    try {
      const rows = await getAgentTradeRows(record.operatorWallet);
      bps = computeReputationFromRows(rows).reputationBps;
    } catch {
      continue;
    }
    if (bps === record.reputationBps) continue;
    await updateAgentReputationBps(record.agentId, bps, now);
    updated += 1;
  }
  return { scanned: records.length, updated };
}
