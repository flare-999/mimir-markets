import { Link } from "@/i18n/navigation";
import { notFound } from "next/navigation";

import { paginateByCursor } from "@/lib/explorer/cursor";
import { BlueprintHeading } from "@/components/BlueprintGrid";
import { StaleIndexWarning } from "@/components/StaleIndexWarning";
import { AgentAvatar } from "@/components/agents/AgentAvatar";
import { Bps, SignedUsdc, StatBlock, TimeWindowTabs, TrackTag } from "@/components/agents/AgentStats";
import { PerformanceChart } from "@/components/charts/PerformanceChart";
import { AddressChip } from "@/components/ui/AddressChip";
import { cumulativePnlPoints, isTimeWindow, windowSinceMs, type TimeWindow } from "@/lib/agents/performance";
import { freshnessFromMeta } from "@/lib/vs-freshness";
import { buildProfile } from "@/lib/server/profile";
import { unitsToUsdc } from "@/lib/usdc";
import { shortenAddress } from "@/lib/constants";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  return { title: shortenAddress(address), description: `Mimir activity for ${address}` };
}

const OUTCOME_TONE: Record<string, string> = {
  won: "text-pv-emerald",
  lost: "text-pv-danger",
  refunded: "text-pv-muted",
  open: "text-pv-gold",
};

const PAGE_SIZE = 20;

export default async function ProfilePage({
  params, searchParams,
}: {
  params: Promise<{ address: string }>;
  searchParams?: Promise<{ window?: string | string[]; cursor?: string | string[] }>;
}) {
  const [{ address }, sp] = await Promise.all([
    params,
    searchParams ?? Promise.resolve({} as { window?: string | string[] }),
  ]);
  const rawWindow = Array.isArray(sp?.window) ? sp.window[0] : sp?.window;
  const window: TimeWindow = rawWindow && isTimeWindow(rawWindow) ? rawWindow : "all";
  const rawCursor = Array.isArray(sp?.cursor)
    ? sp.cursor[0]
    : sp?.cursor;

  const profile = await buildProfile(address, window).catch(() => null);
  if (!profile) notFound();

  const { performance, results, ownedAgents, agent } = profile;
  const decided = performance.wins + performance.losses;
  const title = agent ? agent.displayName : shortenAddress(profile.address);
  const freshness = freshnessFromMeta(profile.freshness);

  const { items: pageResults, nextCursor } = paginateByCursor(results, rawCursor, PAGE_SIZE);
  const basePath = `/profile/${profile.address}`;
  const buildHref = (cursor: string | null) => {
    const qs = new URLSearchParams();
    if (window !== "all") qs.set("window", window);
    if (cursor) qs.set("cursor", cursor);
    const suffix = qs.toString();
    return suffix ? `${basePath}?${suffix}` : basePath;
  };

  return (
    <div className="pb-12">
      <BlueprintHeading>{title}</BlueprintHeading>
      <div className="mx-auto max-w-[1000px] px-4 pt-6 sm:px-6 lg:px-8">

        <StaleIndexWarning freshness={freshness} />
        <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2.5">
              {agent
                ? <AgentAvatar id={agent.id} address={agent.address} name={agent.displayName} size={40} />
                : <AgentAvatar id="human" address={profile.address} name="Trader" size={40} />}
              {agent
                ? <TrackTag track={agent.track} />
                : (
                  <span className="border border-pv-ink/[0.14] px-1.5 py-px font-mono text-[9px] uppercase tracking-wider text-pv-muted">
                    Trader
                  </span>
                )}
              {ownedAgents.length > 0 && (
                <span className="border border-pv-emerald/40 px-1.5 py-px font-mono text-[9px] uppercase tracking-wider text-pv-emerald">
                  {ownedAgents.length} agent{ownedAgents.length === 1 ? "" : "s"}
                </span>
              )}
            </div>
            {agent && <p className="mt-2 max-w-2xl text-sm text-pv-muted">{agent.description}</p>}
            <div className="mt-1.5">
              <AddressChip address={profile.address} label="wallet" linkToProfile={false} />
            </div>
            {agent && (
              <p className="mt-2 text-[12px] text-pv-muted">
                This is an agent&apos;s own wallet.{" "}
                <Link href={`/agents/${agent.id}`} className="text-pv-emerald hover:underline">
                  See its agent page →
                </Link>
              </p>
            )}
          </div>
          <TimeWindowTabs active={window} basePath={`/profile/${profile.address}`} />
        </header>

        <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatBlock label="Own P&L" hint={`${performance.settled} settled`}>
            {performance.settled === 0
              ? <span className="text-pv-muted">—</span>
              : <SignedUsdc atomic={performance.realisedPnlAtomic} />}
          </StatBlock>
          <StatBlock label="Win rate" hint={decided > 0 ? `${performance.wins}W / ${performance.losses}L` : "no decisions yet"}>
            {decided > 0 ? <Bps bps={performance.winRateBps} /> : <span className="text-pv-muted">—</span>}
          </StatBlock>
          <StatBlock label="Open exposure" hint={`${performance.open} live`}>
            <span className="font-mono tabular-nums">{unitsToUsdc(performance.openExposureAtomic).toFixed(2)}</span>
          </StatBlock>
          <StatBlock
            label="Agents' P&L"
            hint={ownedAgents.length > 0 ? `${profile.agentsSettled} settled by ${ownedAgents.length}` : "no agents"}
          >
            {ownedAgents.length === 0
              ? <span className="text-pv-muted">—</span>
              : <SignedUsdc atomic={profile.agentsRealisedPnlAtomic} />}
          </StatBlock>
        </section>

        <section className="mt-4">
          <h3 className="mb-2 font-mono text-[10px] uppercase tracking-wider text-pv-muted">
            Cumulative P&amp;L
          </h3>
          <PerformanceChart
            points={cumulativePnlPoints(results, { sinceMs: windowSinceMs(window, Date.now()) })}
            baseline={0}
            label={`${title} cumulative P&L`}
            emptyMessage="Nothing settled in this window yet."
          />
        </section>

        {ownedAgents.length > 0 && (
          <section className="mt-8">
            <h3 className="mb-3 font-display text-lg font-bold text-pv-text">Agents created</h3>
            <div className="grid gap-2 sm:grid-cols-2">
              {ownedAgents.map((owned) => (
                <Link
                  key={owned.id}
                  href={`/agents/${owned.id}`}
                  className="group flex items-center gap-3 border border-pv-ink/[0.12] bg-pv-surface/40 p-3 transition-colors hover:border-pv-emerald/45"
                >
                  <AgentAvatar id={owned.id} address={owned.address} name={owned.displayName} size={32} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-sm text-pv-text group-hover:text-pv-emerald">
                        {owned.displayName}
                      </span>
                      <TrackTag track={owned.track} />
                    </span>
                    <span className="block font-mono text-[10px] text-pv-muted">
                      {owned.performance.settled} settled
                    </span>
                  </span>
                  {owned.performance.settled === 0
                    ? <span className="font-mono text-[11px] text-pv-muted">—</span>
                    : <SignedUsdc atomic={owned.performance.realisedPnlAtomic} className="text-[13px]" />}
                </Link>
              ))}
            </div>
          </section>
        )}

        <section className="mt-8">
          <h3 className="mb-3 font-display text-lg font-bold text-pv-text">Positions</h3>
          {pageResults.length === 0 ? (
            <p className="border border-pv-ink/[0.1] bg-pv-surface/40 px-4 py-6 text-sm text-pv-muted">
              This wallet has not taken a position yet.
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
                  {pageResults.map((result) => (
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
          {nextCursor && (
            <div className="mt-4 flex justify-center">
              <Link
                href={buildHref(nextCursor)}
                className="border border-pv-ink/[0.14] px-4 py-2 font-mono text-[11px] uppercase tracking-wider text-pv-text transition-colors hover:border-pv-emerald/45 hover:text-pv-emerald"
              >
                Load more
              </Link>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
