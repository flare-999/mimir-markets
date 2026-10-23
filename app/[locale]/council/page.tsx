import { Suspense } from "react";
import { Link } from "@/i18n/navigation";
import { readContractActivity } from "@/lib/server/contract-activity";
import { readAgentBalances } from "@/lib/agent-wallets";
import { getExplorerAddressUrl, getExplorerTxUrl } from "@/lib/stellar";
import {
  getActiveCouncilPersonas,
} from "@/lib/council-resolver";
import type { PersonaSpec } from "@/agents/council/personas";
import { BlueprintHeading } from "@/components/BlueprintGrid";
import { openPeepsAvatar } from "@/lib/avatars";
import { AddressChip } from "@/components/ui/AddressChip";
import { CouncilPanelSkeleton } from "@/components/ui/AsyncPanelSkeleton";

export const revalidate = 30;

// ── Data ─────────────────────────────────────────────────────────────────────

interface PersonaStats {
  persona:         PersonaSpec;
  address:         string;
  /**
   * The persona's USDC bankroll, not its fee balance.
   *
   * The EVM version showed native ETH here because gas was a scarce budget worth
   * watching. A Stellar fee is 0.00001 XLM against a 10,000 XLM Friendbot grant,
   * so an XLM figure on this card would be a constant. What actually limits a
   * persona is how much USDC it can still stake, which is what this now reports.
   */
  bankrollUsdc:    number;
  stakesPlaced:    number;
  totalStakedUsdc: number;
  recentBets:      Array<{
    claimId:      number;
    stakeUsdc:    number;
    txHash:       string;
    ledger:       number;
  }>;
}

async function fetchCouncilStats(): Promise<PersonaStats[]> {
  const personas = getActiveCouncilPersonas();
  if (personas.length === 0) return [];

  // One event scan for the whole page, grouped by actor. Rows come back newest
  // first, and stakes are already display USDC.
  //
  // NOTE ON COMPLETENESS: Soroban RPC keeps a rolling ~1-week event window, so
  // `stakesPlaced` is "stakes in the retained window", not all-time. The page says
  // so beneath the totals rather than presenting a partial count as a lifetime one.
  const activity = await readContractActivity();
  const byActor = new Map<string, typeof activity.rows>();
  for (const row of activity.rows) {
    if (row.kind !== "challenged" || !row.actor) continue;
    const list = byActor.get(row.actor) ?? [];
    list.push(row);
    byActor.set(row.actor, list);
  }

  return Promise.all(
    personas.map(async ({ persona, address: addr }) => {
      // EXACT key lookup: a Stellar strkey is case-sensitive base32, so the
      // lowercasing the EVM version applied to both sides would match nothing here.
      const rows = byActor.get(addr) ?? [];

      const balances = await readAgentBalances(addr).catch(() => null);

      return {
        persona,
        address: addr,
        bankrollUsdc:    balances?.usdc ?? 0,
        stakesPlaced:    rows.length,
        totalStakedUsdc: rows.reduce((acc, row) => acc + row.stakeUsdc, 0),
        recentBets:      rows.slice(0, 3).map((row) => ({
          claimId:   row.claimId,
          stakeUsdc: row.stakeUsdc,
          txHash:    row.txHash,
          ledger:    row.ledger,
        })),
      };
    }),
  );
}

// ── UI ───────────────────────────────────────────────────────────────────────

const ARCHETYPE_LABEL: Record<PersonaSpec["archetype"], string> = {
  "llm-biased":  "LLM · biased",
  "rule-based":  "Rule · no LLM",
  "specialist":  "Specialist · category-filtered",
  "micro":       "Micro · low threshold",
};

function PersonaCard({ stats }: { stats: PersonaStats }) {
  const { persona, address, bankrollUsdc, stakesPlaced, totalStakedUsdc, recentBets } = stats;
  const active = stakesPlaced > 0;

  return (
    <article className="flex h-full flex-col gap-4 rounded-2xl border border-pv-border/30 bg-pv-surface/70 p-5 transition-colors hover:border-pv-border/60">
      <header className="flex items-start gap-3">
        <span
          className={`relative flex size-14 shrink-0 items-center justify-center rounded-2xl border ${persona.accent.border} ${persona.accent.bg}`}
          aria-hidden
        >
          <span className="absolute inset-0 overflow-hidden rounded-2xl">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={openPeepsAvatar(`council-${persona.slug}`)}
              alt=""
              className="h-full w-full object-cover object-top opacity-95"
            />
          </span>
          <span className="absolute -bottom-1 -right-1 flex size-6 items-center justify-center rounded-full border border-pv-bg bg-pv-surface2 text-[13px] leading-none shadow-[0_4px_12px_rgba(0,0,0,0.35)]">
            {persona.emoji}
          </span>
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="font-display text-base font-bold tracking-tight text-pv-text">
            {persona.displayName}
          </h3>
          <p className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.18em] text-pv-muted">
            {ARCHETYPE_LABEL[persona.archetype]}
          </p>
        </div>
      </header>

      {/* Clamped to two lines: bios differ by a sentence, and letting that ripple
          through the card leaves four cards in a row with four different baselines. */}
      <p className="line-clamp-2 min-h-[2.75rem] text-[12px] leading-relaxed text-pv-text/75">{persona.bio}</p>

      {persona.categoryFilter && persona.categoryFilter.length > 0 && (
        <div className="flex flex-wrap gap-1 font-mono text-[10px] uppercase tracking-[0.14em] text-pv-muted">
          {persona.categoryFilter.map((c) => (
            <span key={c} className="rounded border border-pv-border/40 px-1.5 py-0.5">{c}</span>
          ))}
        </div>
      )}

      <dl className="mt-auto grid grid-cols-3 gap-2 border-t border-pv-border/30 pt-3 text-center">
        <div>
          <dt className="font-mono text-[10px] uppercase tracking-[0.16em] text-pv-muted">bankroll</dt>
          <dd className="mt-0.5 font-display text-sm font-bold tabular-nums text-pv-text">
            {bankrollUsdc.toFixed(2)}
          </dd>
        </div>
        <div>
          <dt className="font-mono text-[10px] uppercase tracking-[0.16em] text-pv-muted">stakes</dt>
          <dd className={`mt-0.5 font-display text-sm font-bold tabular-nums ${active ? "text-pv-emerald" : "text-pv-text"}`}>
            {stakesPlaced}
          </dd>
        </div>
        <div>
          <dt className="font-mono text-[10px] uppercase tracking-[0.16em] text-pv-muted">at risk</dt>
          <dd className="mt-0.5 font-display text-sm font-bold tabular-nums text-pv-text">
            {totalStakedUsdc.toFixed(2)}
          </dd>
        </div>
      </dl>

      <div className="min-h-[3.25rem]">
      {recentBets.length > 0 ? (
        <ul className="space-y-1.5 border-t border-pv-border/30 pt-3">
          {recentBets.map((b) => (
            <li key={b.txHash} className="flex items-baseline justify-between gap-2 font-mono text-[10px]">
              <Link href={`/vs/${b.claimId}`} className="text-pv-emerald hover:underline">
                claim #{b.claimId}
              </Link>
              <span className="tabular-nums text-pv-text/85">{b.stakeUsdc.toFixed(2)} USDC</span>
              <a
                href={getExplorerTxUrl(b.txHash)}
                target="_blank"
                rel="noreferrer"
                className="text-pv-muted hover:text-pv-emerald"
              >
                tx ↗
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <p className="border-t border-pv-border/30 pt-3 text-center font-mono text-[10px] italic text-pv-muted">
          no bets yet — waiting for an in-character market
        </p>
      )}
      </div>

      <div className="flex justify-center">
        <AddressChip address={address} label={persona.displayName} className="text-[10px]" />
      </div>
    </article>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

function CouncilSummarySkeleton() {
  return (
    <div
      className="flex flex-wrap items-center justify-center gap-2 pt-2"
      aria-busy
      aria-label="Loading council summary"
      role="status"
    >
      <span className="sr-only">Loading council summary</span>
      {Array.from({ length: 4 }).map((_, i) => (
        <span
          key={i}
          className="h-6 w-28 rounded-md bg-pv-ink/[0.08] motion-safe:animate-pulse motion-reduce:animate-none motion-reduce:opacity-90"
          aria-hidden
        />
      ))}
    </div>
  );
}

function CouncilGridSkeleton() {
  return (
    <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      <CouncilPanelSkeleton rows={4} />
      <CouncilPanelSkeleton rows={4} className="hidden md:block" />
      <CouncilPanelSkeleton rows={4} className="hidden lg:block" />
      <CouncilPanelSkeleton rows={4} className="hidden xl:block" />
    </div>
  );
}

async function CouncilSummary({
  statsPromise,
}: {
  statsPromise: Promise<PersonaStats[]>;
}) {
  const stats = await statsPromise;
  if (stats.length === 0) return null;

  const totalStakes       = stats.reduce((acc, s) => acc + s.stakesPlaced, 0);
  const totalStakedUsdc   = stats.reduce((acc, s) => acc + s.totalStakedUsdc, 0);
  const totalBankrollUsdc = stats.reduce((acc, s) => acc + s.bankrollUsdc, 0);

  return (
    <>
      <div className="flex flex-wrap items-center justify-center gap-2 pt-2 font-mono text-[11px] uppercase tracking-[0.16em]">
        <span className="rounded-md border border-pv-border/40 bg-pv-surface2/40 px-2 py-1 text-pv-muted">
          {stats.length} active
        </span>
        <span className="rounded-md border border-pv-border/40 bg-pv-surface2/40 px-2 py-1 text-pv-muted">
          {totalStakes} stakes
        </span>
        <span className="rounded-md border border-pv-border/40 bg-pv-surface2/40 px-2 py-1 text-pv-muted">
          <span className="tabular-nums text-pv-text">{totalStakedUsdc.toFixed(2)}</span> USDC at risk
        </span>
        <span className="rounded-md border border-pv-border/40 bg-pv-surface2/40 px-2 py-1 text-pv-muted">
          bankroll <span className="tabular-nums text-pv-text">{totalBankrollUsdc.toFixed(2)}</span> USDC
        </span>
      </div>
      {/*
        Said plainly rather than left implied: Soroban RPC retains roughly a
        week of events, so the stake counts above are a recent window, not a
        lifetime tally. Presenting a partial count as all-time would make an
        active persona look idle after a quiet week.
      */}
      <p className="pt-1 text-center font-mono text-[10px] uppercase tracking-[0.16em] text-pv-muted">
        stake counts cover the last ~7 days of ledger events
      </p>
    </>
  );
}

async function CouncilPersonaGrid({
  statsPromise,
}: {
  statsPromise: Promise<PersonaStats[]>;
}) {
  const stats = await statsPromise;

  if (stats.length === 0) {
    return (
      <div className="rounded-2xl border border-pv-border/30 bg-pv-surface/70 p-12 text-center">
        <p className="text-base text-pv-text">No council personas configured in this deploy.</p>
        <p className="mt-2 text-sm text-pv-muted">
          Run <code className="font-mono text-pv-emerald">npm run agents:create-wallets</code> to provision the 10 local council keys, then add the resulting <code className="font-mono text-pv-emerald">COUNCIL_&lt;SLUG&gt;_ADDRESS</code> env vars to this deploy.
        </p>
      </div>
    );
  }

  return (
    <section className="grid gap-3 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {stats.map((s) => <PersonaCard key={s.persona.slug} stats={s} />)}
    </section>
  );
}

export default function CouncilPage() {
  const statsPromise = fetchCouncilStats();

  return (
    <div className="pb-10">
      <BlueprintHeading>Twenty AI frames. Twenty local wallets. One market.</BlueprintHeading>
      <div className="mx-auto max-w-[1200px] px-4 pt-6 sm:px-6 lg:px-8">
      <header className="mb-10 space-y-1.5">
        <p className="mx-auto max-w-2xl text-center text-sm text-pv-muted">
          Each persona reads the same claims and the same evidence but reaches different
          verdicts based on character — optimists tilt up, doomers tilt down, contrarians
          chase imbalance, specialists only touch their domain. Every stake below is a real
          on-chain USDC stake signed by that persona&apos;s local worker key.
        </p>
        <Suspense fallback={<CouncilSummarySkeleton />}>
          <CouncilSummary statsPromise={statsPromise} />
        </Suspense>
      </header>

      <Suspense fallback={<CouncilGridSkeleton />}>
        <CouncilPersonaGrid statsPromise={statsPromise} />
      </Suspense>

      <nav className="mt-10 flex flex-wrap justify-center gap-x-6 gap-y-2 text-sm">
        <Link href="/agents" className="text-pv-muted transition-colors hover:text-pv-text">← all agent activity</Link>
        <Link href="/stats" className="text-pv-muted transition-colors hover:text-pv-text">aggregate stats →</Link>
      </nav>
      </div>
    </div>
  );
}