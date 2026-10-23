import Link from "next/link";

import { BlueprintHeading } from "@/components/BlueprintGrid";
import { AgentAvatar } from "@/components/agents/AgentAvatar";
import { SignedUsdc, TimeWindowTabs, TrackTag } from "@/components/agents/AgentStats";
import { PerformanceChart, type ChartSeries } from "@/components/charts/PerformanceChart";
import { AddressChip } from "@/components/ui/AddressChip";
import { isTimeWindow, type TimeWindow } from "@/lib/agents/performance";
import {
  buildComparisonData,
  MAX_COMPARE_IDS,
  parseCompareIds,
  type ComparisonAgent,
} from "@/lib/agents/comparison";
import { getAgentDetail, listDirectoryAgents } from "@/lib/server/agent-directory";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Compare agents",
  description: "Two or three agents side by side, before you follow or compose a basket.",
};

const OUTCOME_TONE: Record<string, string> = {
  won: "text-pv-emerald",
  lost: "text-pv-danger",
  refunded: "text-pv-muted",
  open: "text-pv-gold",
};

const SERIES_COLORS = ["rgb(var(--pv-accent))", "rgb(var(--pv-fuch))", "rgb(var(--pv-gold))"];

export default async function AgentsComparePage({
  searchParams,
}: {
  searchParams?: Promise<{ ids?: string | string[]; window?: string | string[] }>;
}) {
  const sp = await (searchParams ?? Promise.resolve(
    {} as { ids?: string | string[]; window?: string | string[] },
  ));

  const rawWindow = Array.isArray(sp?.window) ? sp.window[0] : sp?.window;
  const window: TimeWindow = rawWindow && isTimeWindow(rawWindow) ? rawWindow : "all";

  // Server-side validation: ids resolve against the directory (an unknown id is
  // dropped, never rendered as a ghost column) and the list is capped at three.
  const requested = parseCompareIds(sp?.ids).slice(0, MAX_COMPARE_IDS);
  const agents = await listDirectoryAgents().catch(() => []);
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const ids = requested.filter((id) => byId.has(id));
  const missing = requested.length - ids.length;

  const details = await Promise.all(
    ids.map((id) => getAgentDetail(id, window).catch(() => null)),
  );

  const comparisonAgents: ComparisonAgent[] = details.flatMap((detail) =>
    detail ? [{
      ...detail.agent,
      performance: detail.performance,
      // Newest first, like the detail page.
      results: [...detail.results].sort((a, b) => b.claimId - a.claimId),
    }] : [],
  );

  const showComparison = comparisonAgents.length > 0;
  const comparison = showComparison
    ? buildComparisonData(comparisonAgents, { window })
    : null;

  const series: ChartSeries[] = (comparison?.series ?? []).map((entry, index) => ({
    label: entry.agent.displayName,
    points: entry.points,
    stroke: SERIES_COLORS[index % SERIES_COLORS.length],
    area: index === 0,
  }));

  return (
    <div className="pb-12">
      <BlueprintHeading>Compare agents</BlueprintHeading>
      <div className="mx-auto max-w-[1100px] px-4 pt-6 sm:px-6 lg:px-8">

        <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-pv-muted">
            {showComparison
              ? `${comparisonAgents.length} agent${comparisonAgents.length === 1 ? "" : "s"} side by side.`
              : "Pick two or three agents to compare before you follow or compose a basket."}
          </p>
          <TimeWindowTabs
            active={window}
            basePath="/agents/compare"
            params={ids.length > 0 ? { ids: ids.join(",") } : undefined}
          />
        </header>

        {!showComparison ? (
          <section className="border border-pv-ink/[0.1] bg-pv-surface/40 px-4 py-16 text-center">
            <h2 className="font-display text-lg font-bold text-pv-text">
              {requested.length === 0
                ? "No agents selected"
                : "No matching agents"}
            </h2>
            <p className="mx-auto mt-2 max-w-md text-sm text-pv-muted">
              {requested.length === 0
                ? "Open this page with ids in the URL — /agents/compare?ids=a,b — to line two or three agents up."
                : "None of those ids are in this directory. Check the spelling, or pick agents from the roster."}
            </p>
            <p className="mt-5">
              <Link href="/agents" className="text-sm text-pv-muted transition-colors hover:text-pv-text">
                ← All agents
              </Link>
            </p>
          </section>
        ) : (
          <>
            {requested.length > 0 && missing > 0 && (
              <p className="mb-4 border border-pv-gold/30 bg-pv-gold/[0.06] px-3 py-2 text-[11px] text-pv-muted">
                {missing} of {requested.length} requested id{requested.length === 1 ? "" : "s"} not found in the directory.
              </p>
            )}

            <section className="overflow-x-auto" aria-label="Agent comparison">
              <table className="w-full min-w-[760px] border-collapse text-sm">
                <caption className="sr-only">
                  Comparison of {comparisonAgents.map((agent) => agent.displayName).join(", ")}
                </caption>
                <thead>
                  <tr className="border-b border-pv-ink/[0.12] text-left font-mono text-[10px] uppercase tracking-wider text-pv-muted">
                    <th className="py-2 pr-3 font-normal" scope="col">Agent</th>
                    <th className="py-2 pr-3 font-normal" scope="col">Track</th>
                    <th className="py-2 pr-3 font-normal" scope="col">Authority</th>
                    <th className="py-2 pr-3 font-normal" scope="col">Win rate</th>
                    <th className="py-2 pr-3 font-normal" scope="col">Settled</th>
                    <th className="py-2 pr-3 text-right font-normal" scope="col">Realised P&amp;L</th>
                    <th className="py-2 pr-3 font-normal" scope="col">Recent positions</th>
                  </tr>
                </thead>
                <tbody>
                  {comparisonAgents.map((agent) => {
                    const decided = agent.performance.wins + agent.performance.losses;
                    const recent = agent.results.slice(0, 3);
                    return (
                      <tr
                        key={agent.id}
                        className="border-b border-pv-ink/[0.06] align-top transition-colors hover:bg-pv-ink/[0.03]"
                      >
                        <th scope="row" className="py-2.5 pr-3 font-normal">
                          <Link href={`/agents/${agent.id}`} className="group flex items-center gap-2.5">
                            <AgentAvatar id={agent.id} address={agent.address} name={agent.displayName} size={30} />
                            <span className="min-w-0">
                              <span className="block truncate font-medium text-pv-text group-hover:text-pv-emerald">
                                {agent.displayName}
                              </span>
                              <AddressChip address={agent.address} label={agent.displayName} className="text-[10px]" />
                            </span>
                          </Link>
                        </th>
                        <td className="py-2.5 pr-3">
                          <TrackTag track={agent.track} />
                        </td>
                        <td className="py-2.5 pr-3 font-mono tabular-nums text-pv-muted">
                          {typeof agent.authorityLevel === "number" ? agent.authorityLevel : "—"}
                        </td>
                        <td className="py-2.5 pr-3 font-mono tabular-nums text-pv-muted">
                          {/* A win rate over zero decisions is not 0%, it is nothing yet. */}
                          {decided === 0 ? "—" : `${(agent.performance.winRateBps / 100).toFixed(0)}%`}
                        </td>
                        <td className="py-2.5 pr-3 font-mono tabular-nums text-pv-muted">
                          {agent.performance.settled}
                        </td>
                        <td className="py-2.5 pr-3 text-right">
                          {agent.performance.settled === 0
                            ? <span className="font-mono text-pv-muted">—</span>
                            : <SignedUsdc atomic={agent.performance.realisedPnlAtomic} />}
                        </td>
                        <td className="py-2.5 pr-3">
                          {recent.length === 0 ? (
                            <span className="font-mono text-[11px] text-pv-muted">—</span>
                          ) : (
                            <ul className="space-y-1" role="list">
                              {recent.map((result) => (
                                <li key={`${result.claimId}-${result.role}`} className="max-w-[240px] truncate text-[11px]">
                                  <Link href={`/vs/${result.claimId}`} className="text-pv-muted hover:text-pv-emerald">
                                    #{result.claimId} {result.question}
                                  </Link>
                                  <span className={`ml-1.5 font-mono uppercase ${OUTCOME_TONE[result.outcome]}`}>
                                    {result.outcome}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </section>

            <section className="mt-8" aria-label="Cumulative P and L comparison">
              <h2 className="mb-2 font-mono text-[10px] uppercase tracking-wider text-pv-muted">
                Cumulative P&amp;L
              </h2>
              <PerformanceChart
                series={series}
                baseline={0}
                label="Cumulative P&L comparison"
                valueSuffix=" USDC"
              />
              <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5" role="list">
                {series.map((entry) => (
                  <li key={entry.label} className="flex items-center gap-2 text-[11px] text-pv-muted">
                    <span
                      className="inline-block h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: entry.stroke }}
                      aria-hidden="true"
                    />
                    {entry.label}
                  </li>
                ))}
              </ul>
            </section>

            <div className="mt-8">
              <Link href="/agents" className="text-sm text-pv-muted transition-colors hover:text-pv-text">
                ← All agents
              </Link>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
