import { Link } from "@/i18n/navigation";
import { notFound } from "next/navigation";

import { BlueprintHeading } from "@/components/BlueprintGrid";
import { Bps, SignedUsdc, StatBlock, TimeWindowTabs, TrackTag } from "@/components/agents/AgentStats";
import { AgentAvatar, AgentAvatarStack } from "@/components/agents/AgentAvatar";
import { PerformanceChart } from "@/components/charts/PerformanceChart";
import { FollowBasket } from "@/components/baskets/FollowBasket";
import { AddressChip } from "@/components/ui/AddressChip";
import { isTimeWindow, type TimeWindow } from "@/lib/agents/performance";
import { buildBasketView, findAnyBasketDefinition, findBasketDefinition } from "@/lib/server/basket-directory";
import { unitsToUsdc } from "@/lib/usdc";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const definition = findBasketDefinition(id) ?? await findAnyBasketDefinition(id).catch(() => null);
  return {
    title: definition ? definition.name : "Basket",
    description: definition?.thesis,
  };
}

export default async function BasketDetailPage({
  params, searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ window?: string | string[] }>;
}) {
  const [{ id }, sp] = await Promise.all([
    params,
    searchParams ?? Promise.resolve({} as { window?: string | string[] }),
  ]);
  const definition = await findAnyBasketDefinition(id).catch(() => null);
  if (!definition) notFound();

  const rawWindow = Array.isArray(sp?.window) ? sp.window[0] : sp?.window;
  const window: TimeWindow = rawWindow && isTimeWindow(rawWindow) ? rawWindow : "all";
  const basket = await buildBasketView(definition, window).catch(() => null);
  if (!basket) notFound();

  const decided = basket.wins + basket.losses;

  return (
    <div className="pb-12">
      <BlueprintHeading>{definition.name}</BlueprintHeading>
      <div className="mx-auto max-w-[1000px] px-4 pt-6 sm:px-6 lg:px-8">

        <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <AgentAvatarStack agents={basket.members} size={34} max={8} />
            <p className="mt-2.5 max-w-2xl text-sm text-pv-muted">{definition.thesis}</p>
          </div>
          <TimeWindowTabs active={window} basePath={`/baskets/${definition.id}`} />
        </header>

        <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatBlock label="Return" hint="virtual NAV over the window">
            <Bps bps={basket.returnBps} />
          </StatBlock>
          <StatBlock label="Realised P&L" hint={`${basket.settled} settled across members`}>
            {basket.settled === 0
              ? <span className="text-pv-muted">—</span>
              : <SignedUsdc atomic={basket.realisedPnlAtomic} />}
          </StatBlock>
          <StatBlock label="Win rate" hint={decided > 0 ? `${basket.wins}W / ${basket.losses}L` : "no decisions yet"}>
            {decided > 0 ? <Bps bps={basket.winRateBps} /> : <span className="text-pv-muted">—</span>}
          </StatBlock>
          <StatBlock label="Max drawdown" hint="peak to trough">
            <span className="font-mono tabular-nums text-pv-muted">
              {(basket.maxDrawdownBps / 100).toFixed(2)}%
            </span>
          </StatBlock>
        </section>

        <section className="mt-6">
          <FollowBasket basketId={definition.id} creatorWallet={definition.creatorWallet} />
        </section>

        <section className="mt-6">
          <h3 className="mb-2 font-mono text-[10px] uppercase tracking-wider text-pv-muted">
            NAV curve
          </h3>
          <PerformanceChart
            points={basket.snapshots.map((snapshot) => ({
              timestamp: snapshot.timestamp,
              value: unitsToUsdc(snapshot.navAtomic),
            }))}
            baseline={unitsToUsdc(basket.initialNavAtomic)}
            label={`${definition.name} NAV`}
            emptyMessage="No settled results in this window yet — the curve starts once members settle a market."
          />
        </section>

        <section className="mt-8">
          <h3 className="mb-3 font-display text-lg font-bold text-pv-text">Members</h3>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[680px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-pv-ink/[0.12] text-left font-mono text-[10px] uppercase tracking-wider text-pv-muted">
                  <th className="py-2 pr-3 font-normal">Agent</th>
                  <th className="py-2 pr-3 font-normal">Weight</th>
                  <th className="py-2 pr-3 font-normal">Settled</th>
                  <th className="py-2 pr-3 font-normal">Own P&amp;L</th>
                  <th className="py-2 pr-3 text-right font-normal">Contribution</th>
                </tr>
              </thead>
              <tbody>
                {basket.members.map((member) => (
                  <tr key={member.id} className="border-b border-pv-ink/[0.06]">
                    <td className="py-2.5 pr-3">
                      <Link href={`/agents/${member.id}`} className="group flex items-center gap-2.5">
                        <AgentAvatar id={member.id} address={member.address} name={member.displayName} size={28} />
                        <span className="min-w-0">
                          <span className="flex items-center gap-2">
                            <span className="truncate text-pv-text group-hover:text-pv-emerald">
                              {member.displayName}
                            </span>
                            <TrackTag track={member.track} />
                          </span>
                          <span className="block">
                            <AddressChip address={member.address} label={member.displayName} className="text-[10px]" />
                          </span>
                        </span>
                      </Link>
                    </td>
                    <td className="py-2.5 pr-3 font-mono tabular-nums text-pv-muted">
                      {(member.weightBps / 100).toFixed(0)}%
                    </td>
                    <td className="py-2.5 pr-3 font-mono tabular-nums text-pv-muted">
                      {member.performance.settled}
                    </td>
                    <td className="py-2.5 pr-3">
                      {member.performance.settled === 0
                        ? <span className="font-mono text-pv-muted">—</span>
                        : <SignedUsdc atomic={member.performance.realisedPnlAtomic} />}
                    </td>
                    <td className="py-2.5 pr-3 text-right">
                      {member.performance.settled === 0
                        ? <span className="font-mono text-pv-muted">—</span>
                        : <SignedUsdc atomic={member.contributionAtomic} />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {basket.missing.length > 0 && (
            <p className="mt-3 text-[11px] text-pv-gold">
              Not configured in this deploy: {basket.missing.join(", ")}. Their weight sits idle.
            </p>
          )}
          {basket.policyErrors.length > 0 && (
            <p className="mt-2 text-[11px] text-pv-danger">
              Policy: {basket.policyErrors.join(", ")}
            </p>
          )}
        </section>

        <p className="mt-6 text-[11px] text-pv-muted">
          Contribution is a member&apos;s realised P&amp;L scaled by its weight — what it did to
          the basket, not what it did on its own book.
        </p>

        <div className="mt-6">
          <Link href="/baskets" className="text-sm text-pv-muted transition-colors hover:text-pv-text">
            ← All baskets
          </Link>
        </div>
      </div>
    </div>
  );
}
