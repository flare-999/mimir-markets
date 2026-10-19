import { Link } from "@/i18n/navigation";

import { BlueprintHeading } from "@/components/BlueprintGrid";
import { Bps, SignedUsdc, TimeWindowTabs } from "@/components/agents/AgentStats";
import { AgentAvatarStack } from "@/components/agents/AgentAvatar";
import { BasketLeaderboard } from "@/components/baskets/BasketLeaderboard";
import { PendingMirrors } from "@/components/baskets/PendingMirrors";
import { PerformanceChart } from "@/components/charts/PerformanceChart";
import { unitsToUsdc } from "@/lib/usdc";
import { isTimeWindow, type TimeWindow } from "@/lib/agents/performance";
import { listBasketViews } from "@/lib/server/basket-directory";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Baskets",
  description: "Weighted mixes of Mimir agents, backtested against what they actually settled.",
};

export default async function BasketsPage({
  searchParams,
}: {
  searchParams?: Promise<{ window?: string | string[]; q?: string | string[] }>;
}) {
  const sp = await (searchParams ?? Promise.resolve({} as { window?: string | string[]; q?: string | string[] }));
  const rawWindow = Array.isArray(sp?.window) ? sp.window[0] : sp?.window;
  const window: TimeWindow = rawWindow && isTimeWindow(rawWindow) ? rawWindow : "all";
  const query = (Array.isArray(sp?.q) ? sp.q[0] : sp?.q ?? "").trim();

  const all = await listBasketViews(window).catch(() => []);

  // Leaderboards read the full set, not the filtered one: "top earning" means top
  // overall, and recomputing it per search would make the ranking meaningless.
  const topEarning = [...all]
    .filter((basket) => basket.settled > 0)
    .sort((a, b) => (b.realisedPnlAtomic > a.realisedPnlAtomic ? 1 : -1))
    .slice(0, 3);
  const topFollowed = [...all]
    .filter((basket) => (basket.definition.subscriberCount ?? 0) > 0)
    .sort((a, b) => (b.definition.subscriberCount ?? 0) - (a.definition.subscriberCount ?? 0))
    .slice(0, 3);

  const term = query.toLowerCase();
  const baskets = term
    ? all.filter((basket) =>
        basket.definition.name.toLowerCase().includes(term)
        || basket.definition.thesis.toLowerCase().includes(term)
        || basket.members.some((member) => member.displayName.toLowerCase().includes(term)))
    : all;

  return (
    <div className="pb-12">
      <BlueprintHeading>Agent baskets</BlueprintHeading>
      <div className="mx-auto max-w-[1000px] px-4 pt-6 sm:px-6 lg:px-8">

        <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-2xl text-sm text-pv-muted">
            A basket is a weighted mix of agents. Each curve is built from what its members
            actually settled on chain — no funds are pooled and nothing is deposited.
          </p>
          <div className="flex items-center gap-2">
            <Link href="/baskets/new" className="btn-compact-primary px-3.5 py-1.5 text-[12px] focus-ring">
              Create basket
            </Link>
            <TimeWindowTabs active={window} basePath="/baskets" />
          </div>
        </header>

        {(topEarning.length > 0 || topFollowed.length > 0) && (
          <section className="mb-6 grid gap-3 sm:grid-cols-2">
            <BasketLeaderboard
              title="Top earning"
              hint="realised P&L across members"
              baskets={topEarning}
              window={window}
              render={(basket) => <SignedUsdc atomic={basket.realisedPnlAtomic} />}
            />
            <BasketLeaderboard
              title="Most followed"
              hint="wallets mirroring this basket"
              baskets={topFollowed}
              window={window}
              render={(basket) => (
                <span className="font-mono tabular-nums text-pv-text">
                  {basket.definition.subscriberCount ?? 0}
                </span>
              )}
            />
          </section>
        )}

        <div className="mb-5">
          <PendingMirrors />
        </div>

        {/* GET form: a search you can bookmark and share, and one that works with
            JavaScript off. */}
        <form method="GET" action="/baskets" className="mb-5 flex gap-2">
          {window !== "all" && <input type="hidden" name="window" value={window} />}
          <input
            type="search"
            name="q"
            defaultValue={query}
            placeholder="Search baskets by name, thesis or member"
            aria-label="Search baskets"
            className="w-full border border-pv-ink/[0.14] bg-pv-surface2/60 px-3 py-2 text-sm text-pv-text outline-none transition-colors placeholder:text-pv-muted focus:border-pv-emerald/50"
          />
          <button type="submit" className="border border-pv-ink/[0.14] px-3 py-2 font-mono text-[11px] uppercase tracking-wider text-pv-muted transition-colors hover:text-pv-text">
            Search
          </button>
        </form>

        {query && (
          <p className="mb-3 text-[12px] text-pv-muted">
            {baskets.length} basket{baskets.length === 1 ? "" : "s"} matching “{query}”.{" "}
            <Link href="/baskets" className="text-pv-emerald hover:underline">Clear</Link>
          </p>
        )}

        {baskets.length === 0 ? (
          <p className="border border-pv-ink/[0.1] bg-pv-surface/40 px-4 py-6 text-sm text-pv-muted">
            No baskets are available right now.
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {baskets.map((basket) => (
              <Link
                key={basket.definition.id}
                href={`/baskets/${basket.definition.id}${window === "all" ? "" : `?window=${window}`}`}
                className="group flex h-full flex-col border border-pv-ink/[0.12] bg-pv-surface/40 p-4 transition-colors hover:border-pv-emerald/45"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="font-display text-base font-bold text-pv-text group-hover:text-pv-emerald">
                      {basket.definition.name}
                    </h3>
                    <div className="mt-1.5">
                      <AgentAvatarStack agents={basket.members} size={24} max={5} />
                    </div>
                    <p className="mt-1.5 line-clamp-2 min-h-[2.5rem] text-[12px] leading-5 text-pv-muted">{basket.definition.thesis}</p>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="font-display text-lg font-bold">
                      <Bps bps={basket.returnBps} />
                    </div>
                    <div className="font-mono text-[10px] uppercase tracking-wider text-pv-muted">
                      NAV
                    </div>
                  </div>
                </div>

                <div className="mt-3 mb-3">
                  <PerformanceChart
                    points={basket.snapshots.map((snapshot) => ({
                      timestamp: snapshot.timestamp,
                      value: unitsToUsdc(snapshot.navAtomic),
                    }))}
                    baseline={unitsToUsdc(basket.initialNavAtomic)}
                    label={`${basket.definition.name} NAV`}
                    height={72}
                    emptyMessage="No settled results yet."
                  />
                </div>

                <dl className="mt-auto grid grid-cols-3 gap-2 border-t border-pv-ink/[0.08] pt-3 text-[11px]">
                  <div>
                    <dt className="font-mono uppercase tracking-wider text-pv-muted">Members</dt>
                    <dd className="mt-0.5 font-mono tabular-nums text-pv-text">
                      {basket.members.length}
                      {basket.missing.length > 0 && (
                        <span className="text-pv-gold"> (+{basket.missing.length} missing)</span>
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt className="font-mono uppercase tracking-wider text-pv-muted">Settled</dt>
                    <dd className="mt-0.5 font-mono tabular-nums text-pv-text">{basket.settled}</dd>
                  </div>
                  <div>
                    <dt className="font-mono uppercase tracking-wider text-pv-muted">P&amp;L</dt>
                    <dd className="mt-0.5">
                      {basket.settled === 0
                        ? <span className="font-mono text-pv-muted">—</span>
                        : <SignedUsdc atomic={basket.realisedPnlAtomic} />}
                    </dd>
                  </div>
                </dl>
              </Link>
            ))}
          </div>
        )}

        <p className="mt-6 text-[11px] text-pv-muted">
          Deposits are closed: the accepted ADR forbids accepting funds into a basket before
          audit, legal and eligibility review. These are read-only backtests of published results.
        </p>
      </div>
    </div>
  );
}
