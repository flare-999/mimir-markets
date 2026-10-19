import Link from "next/link";
import { cachedFor } from "@/lib/server/ttl-cache";
import { getClaimSummaries, getClaimCount, getOracle, getOwner } from "@/lib/contract";
import { readAgentBalances } from "@/lib/agent-wallets";
import { readContractActivity } from "@/lib/server/contract-activity";
import {
  STELLAR_EXPLORER_URL,
  getExplorerAddressUrl,
  getExplorerTxUrl,
  isMarketConfigured,
} from "@/lib/stellar";
import { ZERO_HASH_HEX } from "@/lib/content-hash";
import { getPersonaForAddress } from "@/lib/council-resolver";
import type { PersonaSpec } from "@/agents/council/personas";
import { BlueprintHeading } from "@/components/BlueprintGrid";

// Every fetch* below re-scans the chain (a `get_claim` per id, plus one
// `getEvents` walk). That's fine once per 30s, not once per page view — cache
// each so concurrent/rapid visits share one chain round-trip instead of each
// paying the full scan cost.
//
// The event-derived sections (`fetchStakers`, `fetchSettlements`) cover only the
// ~1 week Soroban RPC retains, and say so in the UI. The claim-derived KPIs are
// read from `get_claim`, which is authoritative and complete.
export const metadata = {
  title: "Stats",
  description: "Live on-chain statistics, staker rankings, and oracle settlement performance.",
};

export const revalidate = 30;

// ── Data ─────────────────────────────────────────────────────────────────────

interface Settlement {
  id:           number;
  winnerSide:   number;
  confidence:   number;
  summary:      string;
  evidenceHash: string;
  txHash:       string;
  ledger:       number;
}

interface ClaimRow {
  id:                   number;
  creator:              string;
  question:             string;
  /** Display USDC. */
  creatorStake:         number;
  /** Display USDC. */
  totalChallengerStake: number;
  state:                "open" | "active" | "resolved" | "cancelled";
  winnerSide:           "creator" | "challengers" | "draw" | "unresolvable" | "";
  confidence:           number;
}

const fetchClaims = cachedFor(fetchClaimsUncached, 30_000);

/**
 * Every claim, for the KPI sums.
 *
 * `getClaimSummaries` owns the fan-out now: it walks the range through
 * `mapWithConcurrency` (STELLAR_READ_CONCURRENCY) and each `readClaimRaw` retries
 * with backoff internally. That replaces the hand-rolled worker pool and
 * retry-the-gaps pass this function used to carry — the public Soroban RPC
 * throttles just like the EVM one did, so the limiter still matters, it just lives
 * next to the reads it protects.
 *
 * A claim that stays unreadable is dropped by `getClaimSummaries`, which silently
 * understates a sum, so the shortfall is logged here where the totals are built.
 */
async function fetchClaimsUncached(): Promise<ClaimRow[]> {
  if (!isMarketConfigured()) return [];

  try {
    const total = await getClaimCount();
    if (total <= 0) return [];

    const claims = await getClaimSummaries(1, total);
    if (claims.length < total) {
      console.warn(
        `[stats] ${total - claims.length}/${total} claims unreadable — totals below are short by that many.`,
      );
    }

    return claims.map((claim) => ({
      id:                   claim.id,
      creator:              claim.creator,
      question:             claim.question,
      creatorStake:         claim.creator_stake,
      totalChallengerStake: claim.total_challenger_stake,
      state:                claim.state,
      winnerSide:           claim.winner_side,
      confidence:           claim.confidence,
    }));
  } catch (err) {
    console.error("[stats] fetchClaims failed:", err);
    return [];
  }
}

interface StakerRow {
  address:        string;
  /**
   * First ledger this address was seen acting in — WITHIN the retained event
   * window, which is about a week. Not an all-time debut, and the UI says so.
   */
  firstLedger:    number;
  firstTxHash:    string;
  claimsCreated:  number;
  challengesMade: number;
  kind:           "oracle" | "market-creator" | "council" | "human";
  persona?:       PersonaSpec;
}

const fetchStakers = cachedFor(fetchStakersUncached, 30_000);

async function fetchStakersUncached(oracleAddr?: string, creatorAddr?: string): Promise<StakerRow[]> {
  if (!isMarketConfigured()) return [];
  try {
    // One event walk covers both `claim_created` and `claim_challenged`; the EVM
    // version needed two independent `getLogs` scans because a filter can only
    // name one event signature.
    const activity = await readContractActivity();

    const byAddr = new Map<string, StakerRow>();

    const upsert = (
      rawAddr: string,
      ledger: number,
      txHash: string,
      bump: "created" | "challenged",
    ) => {
      // No case folding and no zero-address check: a strkey is case-sensitive
      // base32, and Soroban has no zero address — an absent actor is an empty
      // string, which the guard below catches.
      const addr = rawAddr.trim();
      if (!addr) return;
      const existing = byAddr.get(addr);
      if (existing) {
        if (ledger < existing.firstLedger) {
          existing.firstLedger = ledger;
          existing.firstTxHash = txHash;
        }
        if (bump === "created")    existing.claimsCreated  += 1;
        else                       existing.challengesMade += 1;
        return;
      }
      const persona = getPersonaForAddress(addr);
      byAddr.set(addr, {
        address: addr,
        firstLedger:    ledger,
        firstTxHash:    txHash,
        claimsCreated:  bump === "created"    ? 1 : 0,
        challengesMade: bump === "challenged" ? 1 : 0,
        kind:
          addr === oracleAddr?.trim()  ? "oracle" :
          addr === creatorAddr?.trim() ? "market-creator" :
          persona                      ? "council" :
                                         "human",
        persona: persona ?? undefined,
      });
    };

    for (const row of activity.rows) {
      if (row.kind === "created") upsert(row.actor, row.ledger, row.txHash, "created");
      else if (row.kind === "challenged") upsert(row.actor, row.ledger, row.txHash, "challenged");
    }

    return Array.from(byAddr.values()).sort((a, b) => a.firstLedger - b.firstLedger);
  } catch (err) {
    console.error("[stats] fetchStakers failed:", err);
    return [];
  }
}

const fetchSettlements = cachedFor(fetchSettlementsUncached, 30_000);

/**
 * The last dozen settlements, newest first.
 *
 * `claims` is passed in so a verdict whose event has aged out of the RPC's
 * retention window can still contribute its confidence — the claim struct keeps it
 * forever, the event does not.
 */
async function fetchSettlementsUncached(claims: ClaimRow[]): Promise<Settlement[]> {
  if (!isMarketConfigured()) return [];
  try {
    const activity = await readContractActivity();
    const detail = new Map(claims.map((claim) => [claim.id, claim]));

    return activity.rows
      .filter((row) => row.kind === "resolved")
      .slice(0, 12)
      .map((row) => ({
        id:           row.claimId,
        winnerSide:   row.winnerSide ?? 0,
        confidence:   row.confidence ?? detail.get(row.claimId)?.confidence ?? 0,
        summary:      row.summary ?? "",
        // The evidence hash is a `BytesN<32>` and decodes to a Buffer, not a string;
        // it is not rendered on this page, so it is left empty rather than half
        // converted. `lib/contract.ts`'s `evidence_hash` is the place to read it.
        evidenceHash: "",
        txHash:       row.txHash,
        ledger:       row.ledger,
      }));
  } catch (err) {
    console.error("[stats] fetchSettlements failed:", err);
    return [];
  }
}

const fetchOracleAndCreator = cachedFor(fetchOracleAndCreatorUncached, 30_000);

async function fetchOracleAndCreatorUncached() {
  if (!isMarketConfigured()) return null;
  try {
    const [oracle, owner] = await Promise.all([getOracle(), getOwner()]);
    if (!oracle || !owner) return null;
    // USDC, not the fee asset. A Stellar fee is 0.00001 XLM against a 10,000 XLM
    // Friendbot grant, so an XLM figure here would be a constant; what tells an
    // operator something is whether the oracle can still stake and settle.
    const [oracleBalances, ownerBalances] = await Promise.all([
      readAgentBalances(oracle),
      readAgentBalances(owner),
    ]);
    return {
      oracle, owner,
      oracleUsdc: oracleBalances.usdc,
      ownerUsdc:  ownerBalances.usdc,
    };
  } catch (err) {
    console.error("[stats] fetchOracleAndCreator failed:", err);
    return null;
  }
}

// ── UI primitives ────────────────────────────────────────────────────────────

function Kpi({ label, value, sub, tone = "default" }: {
  label: string;
  value: string | number;
  sub?:  string;
  tone?: "default" | "accent";
}) {
  return (
    <div className={`rounded-2xl border p-4 ${
      tone === "accent"
        ? "border-pv-emerald/35 bg-pv-emerald/[0.06]"
        : "border-pv-border/30 bg-pv-surface/70"
    }`}>
      <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-pv-muted">{label}</div>
      <div className={`mt-1 font-display text-2xl font-bold tracking-tight tabular-nums ${
        tone === "accent" ? "text-pv-emerald" : "text-pv-text"
      }`}>{value}</div>
      {sub ? <div className="mt-0.5 text-[11px] text-pv-muted">{sub}</div> : null}
    </div>
  );
}

function ConfidenceBar({ label, count, total, color }: {
  label: string;
  count: number;
  total: number;
  color: string;
}) {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between text-[11px]">
        <span className="font-bold uppercase tracking-[0.16em] text-pv-text/85">{label}</span>
        <span className="font-mono text-pv-muted">{count} · {pct}%</span>
      </div>
      <div className="h-2.5 overflow-hidden rounded-full bg-pv-surface2/60">
        <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}

const SIDE_LABEL: Record<number, { label: string; color: string }> = {
  1: { label: "Creator won",      color: "text-pv-emerald" },
  2: { label: "Challengers won",  color: "text-pv-fuch" },
  3: { label: "Draw · refunded",  color: "text-pv-muted" },
  4: { label: "Unresolvable · refunded", color: "text-amber-600" },
};

function tierLabel(c: number): { label: string; cls: string } {
  if (c >= 80) return { label: "FIRM",      cls: "border-pv-emerald/40 bg-pv-emerald/[0.08] text-pv-emerald" };
  if (c >= 60) return { label: "CONTESTED", cls: "border-pv-border/60 bg-pv-surface2/60 text-pv-text/80" };
  return         { label: "LOW",       cls: "border-amber-400/40 bg-amber-400/[0.10] text-amber-700" };
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default async function StatsPage() {
  const [claims, agentInfo] = await Promise.all([fetchClaims(), fetchOracleAndCreator()]);
  // Settlements borrow the claim rows for their summary/confidence fields, so they
  // are fetched after rather than alongside.
  const [settlements, stakers] = await Promise.all([
    fetchSettlements(claims),
    fetchStakers(agentInfo?.oracle, agentInfo?.owner),
  ]);
  const humanStakers   = stakers.filter((s) => s.kind === "human");
  const councilStakers = stakers.filter((s) => s.kind === "council");

  // States are strings now, mirroring the Soroban `ClaimState` enum by name. The
  // EVM version compared numeric discriminants — and the bare `c.state === 0 ||
  // c.state === 1` below was exactly the sort of magic-number pair that silently
  // shifts if a variant is ever inserted.
  const resolvedClaims = claims.filter((c) => c.state === "resolved");
  const totalClaims    = claims.length;
  const totalResolved  = resolvedClaims.length;
  const openClaims     = claims.filter((c) => c.state === "open" || c.state === "active").length;

  // Total wagered = creator stakes + challenger stakes across all claims, in USDC.
  // Already display units, so this is a plain sum — no atomic conversion.
  const totalWageredUsdc = claims.reduce(
    (acc, c) => acc + c.creatorStake + c.totalChallengerStake,
    0,
  );

  // Confidence tiers from resolved on-chain claim state. The settlement
  // timeline below is intentionally capped; aggregate stats must not be.
  const firm      = resolvedClaims.filter((c) => c.confidence >= 80).length;
  const contested = resolvedClaims.filter((c) => c.confidence >= 60 && c.confidence < 80).length;
  const low       = resolvedClaims.filter((c) => c.confidence < 60 && c.confidence > 0).length;
  const accuracyPct =
    totalResolved > 0 ? Math.round((firm / totalResolved) * 100) : 0;

  // Refund rate: a draw or an unresolvable verdict both return the stakes.
  const refunds  = resolvedClaims.filter(
    (c) => c.winnerSide === "draw" || c.winnerSide === "unresolvable",
  ).length;
  const refundPct = totalResolved > 0 ? Math.round((refunds / totalResolved) * 100) : 0;

  const creatorWins    = resolvedClaims.filter((c) => c.winnerSide === "creator").length;
  const challengerWins = resolvedClaims.filter((c) => c.winnerSide === "challengers").length;
  const decided        = creatorWins + challengerWins;

  return (
    <div className="pb-10">
      <BlueprintHeading>Live on-chain stats</BlueprintHeading>
      <div className="mx-auto max-w-[1100px] px-4 pt-6 sm:px-6 lg:px-8">
      <header className="mb-8">
        <p className="text-center text-sm text-pv-muted">
          Every number on this page is read directly from the Mimir contract on Stellar Testnet.
        </p>
      </header>

      {/* Headline KPIs */}
      <section className="mb-10 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Kpi tone="accent" label="Total wagered" value={`${totalWageredUsdc.toFixed(2)} USDC`} sub="creator + challenger stakes" />
        <Kpi label="Unique stakers" value={stakers.length} sub={`${humanStakers.length} human · ${councilStakers.length} council · ${stakers.length - humanStakers.length - councilStakers.length} other agent`} />
        <Kpi label="Claims resolved" value={totalResolved} sub={`${openClaims} open · ${totalClaims} total`} />
        <Kpi label="Oracle accuracy" value={`${accuracyPct}%`} sub="settlements at ≥ 80% confidence" />
        <Kpi label="Refund rate" value={`${refundPct}%`} sub="draw / unresolvable" />
      </section>

      {/* Two-column: confidence distribution + agent vault */}
      <section className="mb-10 grid gap-4 lg:grid-cols-[1.2fr_1fr]">
        <div className="rounded-2xl border border-pv-border/30 bg-pv-surface/70 p-5 sm:p-6">
          <h2 className="mb-1 font-display text-base font-bold tracking-tight text-pv-text">Oracle confidence distribution</h2>
          <p className="mb-5 text-xs text-pv-muted">
            How sure the oracle was when it settled. Mimir refunds the bottom band rather than guess.
          </p>
          <div className="space-y-4">
            <ConfidenceBar label="FIRM · ≥ 80%"      count={firm}      total={totalResolved} color="#5FB0FF" />
            <ConfidenceBar label="CONTESTED · 60-79" count={contested} total={totalResolved} color="#4A90E2" />
            <ConfidenceBar label="LOW · refunded"    count={low}       total={totalResolved} color="#E8C46C" />
          </div>
        </div>

        <div className="rounded-2xl border border-pv-border/30 bg-pv-surface/70 p-5 sm:p-6">
          <h2 className="mb-1 font-display text-base font-bold tracking-tight text-pv-text">Agent vault</h2>
          <p className="mb-5 text-xs text-pv-muted">
            Stellar keypairs the oracle and market-creator sign with. Balances are USDC —
            transaction fees are XLM and are never the binding constraint.
          </p>
          {agentInfo ? (
            <div className="space-y-4 text-sm">
              <div>
                <div className="mb-1 flex items-baseline justify-between">
                  <span className="text-[11px] font-bold uppercase tracking-[0.16em] text-pv-emerald">Oracle</span>
                  <span className="font-mono tabular-nums text-pv-text">
                    {agentInfo.oracleUsdc === null ? "no USDC trustline" : `${agentInfo.oracleUsdc.toFixed(4)} USDC`}
                  </span>
                </div>
                <a className="block break-all font-mono text-[10px] text-pv-muted hover:text-pv-emerald" href={getExplorerAddressUrl(agentInfo.oracle)} target="_blank" rel="noreferrer">
                  {agentInfo.oracle}
                </a>
              </div>
              <div>
                <div className="mb-1 flex items-baseline justify-between">
                  <span className="text-[11px] font-bold uppercase tracking-[0.16em] text-pv-emerald">Market-creator (owner)</span>
                  <span className="font-mono tabular-nums text-pv-text">
                    {agentInfo.ownerUsdc === null ? "no USDC trustline" : `${agentInfo.ownerUsdc.toFixed(4)} USDC`}
                  </span>
                </div>
                <a className="block break-all font-mono text-[10px] text-pv-muted hover:text-pv-emerald" href={getExplorerAddressUrl(agentInfo.owner)} target="_blank" rel="noreferrer">
                  {agentInfo.owner}
                </a>
              </div>
              <p className="border-t border-pv-border/30 pt-3 text-[11px] leading-relaxed text-pv-muted">
                Keys live only in the worker process env (ORACLE_PRIVATE_KEY / CREATOR_PRIVATE_KEY) — never on the web server.
              </p>
            </div>
          ) : (
            <p className="text-sm text-pv-muted">No agent info available.</p>
          )}
        </div>
      </section>

      {/* Decided side split */}
      {decided > 0 && (
        <section className="mb-10 rounded-2xl border border-pv-border/30 bg-pv-surface/70 p-5 sm:p-6">
          <h2 className="mb-4 font-display text-base font-bold tracking-tight text-pv-text">Decided settlements · who won</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-pv-emerald/30 bg-pv-emerald/[0.05] p-4">
              <div className="text-[11px] font-bold uppercase tracking-[0.16em] text-pv-emerald">Creator wins</div>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="font-display text-3xl font-bold tabular-nums text-pv-text">{creatorWins}</span>
                <span className="text-xs text-pv-muted">{Math.round((creatorWins / decided) * 100)}%</span>
              </div>
            </div>
            <div className="rounded-xl border border-pv-border/40 bg-pv-surface2/40 p-4">
              <div className="text-[11px] font-bold uppercase tracking-[0.16em] text-pv-fuch">Challenger wins</div>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="font-display text-3xl font-bold tabular-nums text-pv-text">{challengerWins}</span>
                <span className="text-xs text-pv-muted">{Math.round((challengerWins / decided) * 100)}%</span>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* First stakers wall */}
      <section className="mb-10">
        <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-display text-xl font-bold tracking-tight text-pv-text">First {Math.min(100, stakers.length)} stakers</h2>
          <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-pv-muted">
            ordered by first on-chain stake · earliest first
          </span>
        </div>
        {stakers.length === 0 ? (
          <div className="rounded-2xl border border-pv-border/30 bg-pv-surface/70 p-8 text-center text-sm text-pv-muted">
            No stakers yet. The first wallet to create or challenge a claim takes seat #1.
          </div>
        ) : (
          <ol className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {stakers.slice(0, 100).map((s, i) => {
              const seat = i + 1;
              const tone =
                s.kind === "oracle"         ? "border-pv-emerald/40 bg-pv-emerald/[0.06]" :
                s.kind === "market-creator" ? "border-pv-border/50 bg-pv-surface2/40" :
                s.kind === "council" && s.persona ? `${s.persona.accent.border} ${s.persona.accent.bg}` :
                                              "border-pv-fuch/30 bg-pv-fuch/[0.04]";
              const badge =
                s.kind === "oracle"
                  ? <span className="rounded border border-pv-emerald/40 bg-pv-emerald/[0.10] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.16em] text-pv-emerald">oracle</span>
                : s.kind === "market-creator"
                  ? <span className="rounded border border-pv-border/60 bg-pv-surface2/60 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.16em] text-pv-text/80">m-creator</span>
                : s.kind === "council" && s.persona
                  ? <span className="inline-flex items-center gap-1 rounded border border-pv-border/50 bg-pv-surface2/40 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.16em] text-pv-text/80">
                      <span className="text-[10px] leading-none grayscale opacity-75">{s.persona.emoji}</span>
                      <span className="normal-case">{s.persona.displayName.replace(/^The /, "")}</span>
                    </span>
                  : <span className="rounded border border-pv-fuch/40 bg-pv-fuch/[0.10] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.16em] text-pv-fuch">human</span>;
              return (
                <li
                  key={s.address}
                  className={`flex items-center gap-3 rounded-xl border px-3 py-2.5 ${tone}`}
                >
                  <span className="w-8 shrink-0 text-right font-mono text-[12px] font-bold tabular-nums text-pv-muted">#{seat}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      {badge}
                      <a
                        href={getExplorerAddressUrl(s.address)}
                        target="_blank"
                        rel="noreferrer"
                        className="truncate font-mono text-[11px] text-pv-text/85 hover:text-pv-emerald"
                      >
                        {s.address.slice(0, 6)}…{s.address.slice(-4)} ↗
                      </a>
                    </div>
                    <div className="mt-0.5 font-mono text-[10px] text-pv-muted">
                      {s.claimsCreated > 0 && <>opened {s.claimsCreated}</>}
                      {s.claimsCreated > 0 && s.challengesMade > 0 && <> · </>}
                      {s.challengesMade > 0 && <>challenged {s.challengesMade}</>}
                      {" · ledger "}{s.firstLedger}
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      {/* Recent settlements feed */}
      <section className="mb-10">
        <h2 className="mb-4 font-display text-xl font-bold tracking-tight text-pv-text">Settlement timeline</h2>
        {settlements.length === 0 ? (
          <div className="rounded-2xl border border-pv-border/30 bg-pv-surface/70 p-8 text-center text-sm text-pv-muted">
            No settlements yet. Once the oracle resolves a claim, it appears here.
          </div>
        ) : (
          <div className="space-y-3">
            {settlements.map((s) => {
              const side = SIDE_LABEL[s.winnerSide] ?? { label: "Unknown", color: "text-pv-muted" };
              const tier = tierLabel(s.confidence);
              return (
                <div key={s.txHash} className="rounded-2xl border border-pv-border/30 bg-pv-surface/70 p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px]">
                        <span className="font-mono text-pv-muted">Claim #{s.id}</span>
                        <span className={`font-bold ${side.color}`}>{side.label}</span>
                        <span className={`inline-flex items-center rounded-full border px-2 py-0.5 font-bold uppercase tracking-[0.14em] ${tier.cls}`}>{tier.label} · {s.confidence}%</span>
                      </div>
                      <p className="line-clamp-2 text-[13px] text-pv-text/85">{s.summary}</p>
                      {/* Bare lowercase hex, no `0x` — see lib/content-hash.ts.
                          `lib/contract.ts`'s `toHex` already drops an all-zero
                          digest, so this only has to tolerate a value arriving
                          from some other path. */}
                      {s.evidenceHash &&
                        s.evidenceHash.replace(/^0x/, "") !== ZERO_HASH_HEX && (
                          <div className="mt-1.5 flex items-center gap-1.5">
                            <span className="font-mono text-[10px] uppercase tracking-wide text-pv-muted">Evidence hash:</span>
                            <span className="max-w-[260px] truncate font-mono text-[10px] text-pv-emerald/85">{s.evidenceHash}</span>
                          </div>
                        )}
                    </div>
                    <a
                      href={getExplorerTxUrl(s.txHash)}
                      target="_blank"
                      rel="noreferrer"
                      className="shrink-0 rounded-lg border border-pv-border/40 px-2 py-1 text-[11px] text-pv-muted transition-colors hover:border-pv-emerald hover:text-pv-emerald"
                    >
                      View tx ↗
                    </a>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Resource links */}
      <section className="rounded-2xl border border-pv-border/30 bg-pv-surface/70 p-6">
        <h3 className="mb-4 font-display text-lg font-bold tracking-tight text-pv-text">Get testnet funds</h3>
        <div className="grid gap-3 sm:grid-cols-3">
          {[
            // Friendbot, not a gas faucet with a signup: it creates and funds a
            // testnet account with 10,000 XLM in one request. USDC then comes from
            // the account's own XLM on the SDEX — see scripts/stellar-usdc-faucet.ts.
            { label: "Friendbot",       href: "https://friendbot.stellar.org",     desc: "Create + fund a Testnet account with XLM" },
            { label: "stellar.expert",  href: STELLAR_EXPLORER_URL,                desc: "Inspect contract activity" },
            { label: "Stellar Docs",    href: "https://developers.stellar.org",    desc: "Network, RPC and Soroban guides" },
          ].map(({ label, href, desc }) => {
            const isExternal = href.startsWith("http");
            const linkProps = isExternal
              ? { href, target: "_blank", rel: "noreferrer" as const }
              : { href };
            return (
              <a
                key={href}
                {...linkProps}
                className="rounded-xl border border-pv-border/30 p-3 transition-all hover:border-pv-emerald/40 hover:bg-pv-emerald/[0.04]"
              >
                <div className="text-[13px] font-semibold text-pv-text">{label} {isExternal ? "↗" : "→"}</div>
                <div className="mt-0.5 text-[12px] text-pv-muted">{desc}</div>
              </a>
            );
          })}
        </div>
      </section>

      <div className="mt-6 text-center">
        <Link href="/" className="text-sm text-pv-muted transition-colors hover:text-pv-text">
          ← Back to markets
        </Link>
      </div>
      </div>
    </div>
  );
}
