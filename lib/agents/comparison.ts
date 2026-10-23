/**
 * The comparison builder behind `/agents/compare?ids=a,b,c`.
 *
 * Validation of the `ids` parameter lives here — in a plain module rather than
 * in the page — so the cap and the parsing rules are unit-testable without a
 * server, and so the page only does directory lookups.
 */

import type { TimeWindow } from "./performance";
import { cumulativePnlPoints, windowSinceMs } from "./performance";
import type { AgentPerformance, AgentTradeResult, PnlPoint } from "./performance";
import type { DirectoryAgent } from "@/lib/server/agent-directory";

export interface ComparisonAgent extends DirectoryAgent {
  performance: AgentPerformance;
  results: AgentTradeResult[];
}

export interface ComparisonSeries {
  agent: DirectoryAgent;
  points: PnlPoint[];
}

export interface ComparisonData {
  agents: ComparisonAgent[];
  series: ComparisonSeries[];
}

/** Three at most: a comparison wider than three columns stops being readable. */
export const MAX_COMPARE_IDS = 3;

/**
 * Split a comma list into ids: trimmed, empties dropped, duplicates collapsed.
 *
 * Duplicates are collapsed rather than rejected — a shared link with a repeated
 * id should render the same comparison, not an error. Only the first `ids`
 * occurrence counts when a parameter is repeated, as with every other
 * `searchParams` read in this app.
 */
export function parseCompareIds(raw: string | string[] | undefined): string[] {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return [];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const part of value.split(",")) {
    const id = part.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/**
 * One cumulative P&L series per agent, every series clipped to the same window
 * so the overlaid chart compares like with like.
 */
export function buildComparisonData(
  agents: readonly ComparisonAgent[],
  opts: { window?: TimeWindow; nowMs?: number } = {},
): ComparisonData {
  const window = opts.window ?? "all";
  const nowMs = opts.nowMs ?? Date.now();
  const sinceMs = windowSinceMs(window, nowMs);

  return {
    agents: [...agents],
    series: agents.map((agent) => ({
      agent,
      points: cumulativePnlPoints(agent.results, { sinceMs }),
    })),
  };
}
