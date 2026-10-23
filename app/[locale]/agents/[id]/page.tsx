import Link from "next/link";
import { notFound } from "next/navigation";
import { notFound as notFoundFixture } from "next/navigation";

import { BlueprintHeading } from "@/components/BlueprintGrid";
import { AgentAvatar } from "@/components/agents/AgentAvatar";
import { Bps, SignedUsdc, StatBlock, TimeWindowTabs, TrackTag } from "@/components/agents/AgentStats";
import { PerformanceChart } from "@/components/charts/PerformanceChart";
import { AddressChip } from "@/components/ui/AddressChip";
import { computeReputation } from "@/lib/agents/reputation";
import { cumulativePnlPoints, isTimeWindow, windowSinceMs, type TimeWindow } from "@/lib/agents/performance";
import { getAgentDetail, listDirectoryAgents } from "@/lib/server/agent-directory";
import { findAgentOwner } from "@/lib/server/profile";
import { BASKET_DEFINITIONS } from "@/lib/server/basket-directory";
import { unitsToUsdc } from "@/lib/usdc";
import { isUiFixtureEnabled } from "@/lib/server/ui-fixture";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const agents = await listDirectoryAgents().catch(() => []);
  const agent = agents.find((candidate) => candidate.id === id);
  return {
    title: agent ? agent.displayName : "Agent",
    description: agent?.description,
  };
}

const OUTCOME_TONE: Record<string, string> = {
  won: "text-pv-emerald",
  lost: "text-pv-danger",
  refunded: "text-pv-muted",
  open: "text-pv-gold",
};

export function generateStaticParams() {
  return [];
}

export default async function AgentDetailPage({
  params, searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ window?: string | string[] }>;
}) {
  const [{ id }, sp] = await Promise.all([
    params,
    searchParams ?? Promise.resolve({} as { window?: string | string[] }),
  ]);
  const rawWindow = Array.isArray(sp?.window) ? sp.window[0] : sp?.window;
  const window: TimeWindow = rawWindow && isTimeWindow(rawWindow) ? rawWindow : "all";

  if (id === "__ui-fixture__" && !isUiFixtureEnabled()) {
    notFoundFixture();
  }

  const [detail, owner] = await Promise.all([
    getAgentDetail(id, window).catch(() => null),
    findAgentOwner(id).catch(() => null),
  ]);
  if (!detail) notFound();
  const { agent, performance, results } = detail;

  if (id === "__ui-fixture__" && !isUiFixtureEnabled()) {
    notFound();
  }

  const decided = performance.wins + performance.losses;
  // Recomputed live rather than read from the stored column: the formula is
  // deterministic, and only the live count of decisive settlements can tell
  // "too few results" apart from "zero with enough results" — the stored
  // number collapses both to 0. See docs/adr/0003-observational-reputation-v1.md.
  const reputation = computeReputation(results);
  const memberOf = BASKET_DEFINITIONS.filter((basket) =>
    basket.members.some((member) => member.agentId === agent.id));

  return (
    <div className="pb-12">
      {id === "__ui-fixture__" && (
        <div data-testid="ui-fixture-banner" className="hidden" aria-hidden="true" />
      )}
      <BlueprintHeading>{agent.displayName}</BlueprintHeading>
      <div className="mx-auto max-w-[1000px] px-4 pt-6 sm:px-6 lg:px-8">

        <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2.5">
              <AgentAvatar id={agent.id} address={agent.address} name={agent.displayName} size={40} />
              <TrackTag track={agent.track} />
              {id === "__ui-fixture__" && (
                <span data-testid="ui-fixture-tag" className="hidden" aria-hidden="true">fixture</span>
              )}
              {agent.status && agent.status !== "active" && (
                <span className="border border-pv-danger/40 px-1.5 py-px font-mono text-[9px] uppercase tracking-wider text-pv-danger">
                  {agent.status}
                </span>
              )}
              {typeof agent.authorityLevel === "number" && (
                <span className="border border-pv-ink/[0.14] px-1.5 py-px font-mono text-[9px] uppercase tracking-wider text-pv-muted">
                  authority {agent.authorityLevel}
                </span>
              )}
            </div>
            <p className="mt-2 max-w-2xl text-sm text-pv-muted">{agent.description}</p>
            <dl className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-[11px]">
              {id === "__ui-fixture__" && (
                <div data-testid="ui-fixture-meta" className="hidden" aria-hidden="true" />
              )}
              <div className="flex items-center gap-1.5">
                <dt className="font-mono uppercase tracking-wider text-pv-muted">Agent wallet</dt>
                <dd><AddressChip address={agent.address} label="agent wallet" /></dd>
              </div>
              {owner && (
                <div className="flex items-center gap-1.5">
                  {/* Who made it, so an agent is attributable to a person rather than
                      being an anonymous address with a P&L. */}
                  <dt className="font-mono uppercase tracking-wider text-pv-muted">Created by</dt>
                  <dd><AddressChip address={owner} label="owner" /></dd>
                </div>
              )}
            </dl>
          </div>
          <TimeWindowTabs active={window} basePath={`/agents/${agent.id}`} />
        </header>

        {id === "__ui-fixture__" && (
          <div data-testid="ui-fixture-body" className="hidden" aria-hidden="true" />
        )}

        <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatBlock label="Realised P&L" hint={`${performance.settled} settled`}>
            <SignedUsdc atomic={performance.realisedPnlAtomic} />
          </StatBlock>
          <StatBlock label="Win rate" hint={decided > 0 ? `${performance.wins}W / ${performance.losses}L` : "no decisions yet"}>
            {decided > 0 ? <Bps bps={performance.winRateBps} /> : <span className="text-pv-muted">—</span>}
          </StatBlock>
          <StatBlock
            label="Reputation"
            hint={reputation.sufficient ? `${reputation.decided} decisive · observational` : "insufficient history"}
          >
            {reputation.sufficient ? (
              <span className="font-mono tabular-nums text-pv-text">
                {(reputation.reputationBps / 100).toFixed(2)}%
              </span>
            ) : (
              <span className="text-pv-muted">insufficient history</span>
            )}
          </StatBlock>
          <StatBlock label="Open exposure" hint={`${performance.open} live`}>
            <span className="font-mono tabular-nums">{unitsToUsdc(performance.openExposureAtomic).toFixed(2)}</span>
          </StatBlock>
          <StatBlock label="Volume" hint="all stakes ever placed">
            <span className="font-mono tabular-nums">{unitsToUsdc(performance.volumeAtomic).toFixed(2)}</span>
          </StatBlock>
        </section>

        <section className="mt-4">
          <h3 className="mb-2 font-mono text-[10px] uppercase tracking-wider text-pv-muted">
            Cumulative P&amp;L
          </h3>
          <PerformanceChart
            points={cumulativePnlPoints(results, { sinceMs: windowSinceMs(window, Date.now()) })}
            baseline={0}
            label={`${agent.displayName} cumulative P&L`}
            emptyMessage="Nothing settled in this window yet — the curve starts at the first settlement."
          />
        </section>

        {performance.settled > 0 && (
          <section className="mt-3 grid grid-cols-2 gap-3">
            <StatBlock label="Best market">
              <SignedUsdc atomic={performance.bestPnlAtomic} />
            </StatBlock>
            <StatBlock label="Worst market">
              <SignedUsdc atomic={performance.worstPnlAtomic} />
            </StatBlock>
          </section>
        )}

        {memberOf.length > 0 && (
          <section className="mt-6">
            <h3 className="mb-2 font-mono text-[10px] uppercase tracking-wider text-pv-muted">In baskets</h3>
            <div className="flex flex-wrap gap-2">
              {memberOf.map((basket) => (
                <Link
                  key={basket.id}
                  href={`/baskets/${basket.id}`}
                  className="border border-pv-ink/[0.12] px-2.5 py-1 text-[12px] text-pv-muted transition-colors hover:border-pv-emerald/45 hover:text-pv-text"
                >
                  {basket.emoji} {basket.name}
                </Link>
              ))}
            </div>
          </section>
        )}

        <section className="mt-8">
          <h3 className="mb-3 font-display text-lg font-bold text-pv-text">Positions</h3>
          {results.length === 0 ? (
            <p className="border border-pv-ink/[0.1] bg-pv-surface/40 px-4 py-6 text-sm text-pv-muted">
              This agent has not taken a position yet.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] border-collapse text-sm">
                <thead>
                  <tr className="border-b border-pv-ink/[0.12] text-left font-mono text-[10px] uppercase tracking-wider text-pv-muted">
                    <th className="py-2 pr-3 font-normal">Market</th>
                    <th className="py-2 pr-3 font-normal">Side</th>
                    <th className="py-2 pr-3 font-normal">Stake</th>
                    <th className="py-2 pr-3 font-normal">Outcome</th>
                    <th className="py-2 pr-3 text-right font-normal">P&amp;L</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((result) => (
                    <tr key={`${result.claimId}-${result.role}`} className="border-b border-pv-ink/[0.06]">
                      <td className="max-w-[280px] py-2.5 pr-3">
                        <Link href={`/vs/${result.claimId}`} className="block truncate text-pv-text hover:text-pv-emerald">
                          #{result.claimId} {result.question}
                        </Link>
                      </td>
                      <td className="py-2.5 pr-3 font-mono text-[11px] uppercase text-pv-muted">{result.role}</td>
                      <td className="py-2.5 pr-3 font-mono tabular-nums text-pv-muted">
                        {unitsToUsdc(result.stakeAtomic).toFixed(2)}
                      </td>
                      <td className={`py-2.5 pr-3 font-mono text-[11px] uppercase ${OUTCOME_TONE[result.outcome]}`}>
                        {result.outcome}
                      </td>
                      <td className="py-2.5 pr-3 text-right">
                        {result.outcome === "open"
                          ? <span className="font-mono text-pv-muted">—</span>
                          : <SignedUsdc atomic={result.pnlAtomic} />}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <div className="mt-8">
          {id === "__ui-fixture__" && (
            <div data-testid="ui-fixture-footer" className="hidden" aria-hidden="true" />
          )}
          <Link href="/agents" className="text-sm text-pv-muted transition-colors hover:text-pv-text">
            ← All agents
          </Link>
        </div>
      </div>
    </div>
  );
}

