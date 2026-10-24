/**
 * Mimir Council Worker
 *
 * Boots a single Node process that runs 10 AI personas as autonomous
 * economic actors on Stellar. Every cycle:
 *
 *   1. Reads the claim count + each open/active claim from the contract.
 *   2. Builds a per-cycle evidence cache so 10 personas share 1 HTTP
 *      fetch per resolution URL.
 *   3. For each (claim, persona) pair, runs the decision pipeline:
 *        - Specialists skip out-of-category claims (no LLM call)
 *        - Rule-based personas evaluate from pool state (no LLM call)
 *        - LLM personas call Gemini with a persona-specific prompt prefix
 *   4. Submits challenge_claim through the persona's own Stellar keypair when the
 *      decision says stake.
 *
 * The persona reasoning, rate-limit strategy and cycle budgeting are unchanged.
 * What changed is the read: one `get_claim` returns the whole struct INCLUDING the
 * challenger roster, so the per-claim reads dropped from three to one and the
 * rule-based evaluators no longer touch the chain at all.
 *
 * Rate-limit strategy:
 *   - Personas are processed sequentially within a cycle (not in parallel).
 *   - Gemini free tier = 15 req/min. With 10 LLM personas across ~60s of
 *     work per cycle, we stay comfortably under.
 *   - Rule-based + category-filtered personas don't consume LLM budget.
 *
 * Run: npm run council  (or via "npm run workers" alongside oracle + market-creator)
 * Env: COUNCIL_<SLUG>_PRIVATE_KEY for each persona (addresses derived),
 *      NEXT_PUBLIC_CONTRACT_ADDRESS,
 *      GEMINI_API_KEY (preferred) OR ANTHROPIC_API_KEY
 *      COUNCIL_PERSONAS_ACTIVE (optional CSV of slugs, e.g.
 *        "optimist,pessimist,statistician,whale_watcher,doomer" — restricts
 *        active personas to this subset, cuts LLM load proportionally).
 */

// Worker-scoped Gemini key. Falls back to the shared GEMINI_API_KEY when
// COUNCIL_GEMINI_API_KEY is not set. See agents/oracle/index.ts for the
// rationale: each worker gets its own 20 RPM free-tier bucket.
applyWorkerGeminiKey("COUNCIL_GEMINI_API_KEY");

import { requireAnyLLMKey, applyWorkerGeminiKey } from "../../lib/agent-bootstrap";
import { getClaimCount, readClaimRaw, readClaimsBatch } from "../../lib/contract";
import { readAgentBalances } from "../../lib/agent-wallets";
import { STELLAR_NETWORK, requireMarketContractId } from "../../lib/stellar";
import { unitsToUsdc } from "../../lib/usdc";
import { reportingPoll, runWorkerLoop } from "../../lib/ops/heartbeat";
import { resolvePollJitterMs } from "../../lib/ops/poll-jitter";
import {
  BackoffError,
  DependencyFailureError,
  MalformedInputError,
  StaleStateError,
  DuplicateActionError,
  CancelledByOperatorError,
  PausedWorkerError,
  COUNCIL_BACKOFF,
  describeBackoffError,
  withBackoff,
} from "../../lib/ops/backoff-policies";
import { activeLLMProvider, activeLLMModel, activeLLMKeyFingerprint } from "../../lib/llm";
import {
  listCouncilPersonas,
  personaPublicEnv,
  personaSecretEnv,
  type PersonaSpec,
} from "./personas";
import {
  PHILOSOPHER_PERSONAS,
  activePhilosophers,
  isPhilosopher,
  philosopherPublicEnv,
  philosopherSecretEnv,
} from "./philosophers";
import { runPersonaForClaim } from "./shared/persona-runner";
import { pruneEvidenceCache } from "./shared/evidence-cache";
import { buyPeerReasoning } from "./shared/peer-reasoning";
import { toClaimOnChain } from "./shared/types";
import { parseCouncilConfig } from "./shared/config";
import type {
  ClaimOnChain,
  PersonaRunnerContext,
  EvidenceCacheEntry,
} from "./shared/types";

// ── Config ────────────────────────────────────────────────────────────────────
// Parse and validate all numeric settings up front so a malformed value stops
// the worker at boot instead of silently disabling loops/caps with NaN.
const PARSED_CONFIG = parseCouncilConfig(process.env);
if (!PARSED_CONFIG.ok) {
  console.error("[council] Invalid configuration:");
  for (const error of PARSED_CONFIG.errors) {
    console.error(`  - ${error}`);
  }
  process.exit(1);
}
const CONFIG = PARSED_CONFIG.config;

const POLL_INTERVAL_MS = CONFIG.pollIntervalMs;
// ± around each cycle; unset = 10% of the interval, 0 = fixed scheduling.
const POLL_JITTER_MS = resolvePollJitterMs(POLL_INTERVAL_MS, process.env.COUNCIL_POLL_JITTER_MS);
/**
 * Per-cycle work cap to stay under Gemini free-tier rate limits.
 * Claims are sorted by deadline-proximity so the council focuses on
 * the markets closest to settling.
 */
const MAX_CLAIMS_PER_CYCLE = CONFIG.maxClaimsPerCycle;
const DECISION_DELAY_MS    = CONFIG.decisionDelayMs;
const PEER_READS_ENABLED   = process.env.COUNCIL_PEER_READS === "1";
const PEER_READS_BASE_URL  = process.env.MIMIR_BASE_URL ?? "http://localhost:3000";
const PEER_READS_PER_PERSONA = CONFIG.peerReadsPerPersona;
const PEER_READ_DELAY_MS   = CONFIG.peerReadDelayMs;
const PEER_READ_CAP_USDC   = CONFIG.peerReadCapUsdc;
const CONTRACT_ID          = requireMarketContractId();

// ── Env guard ─────────────────────────────────────────────────────────────────
requireAnyLLMKey();

// Optional CSV allowlist of persona slugs to keep active. When set, personas
// not in the list are skipped even if their wallets exist — used to scale LLM
// load down without re-provisioning wallets.
const PERSONA_ALLOWLIST = (() => {
  const raw = process.env.COUNCIL_PERSONAS_ACTIVE?.trim();
  if (!raw) return null;
  const slugs = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return slugs.length > 0 ? new Set(slugs) : null;
})();

// Skip personas missing a private key (e.g. before agents:create-wallets has
// run for that persona). Warn once at startup, not every cycle.
const CLASSIC_PERSONAS = listCouncilPersonas();
const ACTIVE_PERSONAS = CLASSIC_PERSONAS.filter((p) => {
  if (PERSONA_ALLOWLIST && !PERSONA_ALLOWLIST.has(p.slug)) {
    return false;
  }
  const ok = !!process.env[personaSecretEnv(p)];
  if (!ok) {
    console.warn(
      `[council] ${p.emoji} ${p.displayName} is missing ${personaSecretEnv(p)} — skipping. ` +
      `Run "npm run agents:create-wallets" to provision.`,
    );
  }
  return ok;
});

/**
 * The philosopher track (§04) runs alongside the classic personas.
 *
 * Kept as a separate list rather than merged into COUNCIL_PERSONAS so the two
 * juries can be filtered, funded and scaled independently — and so a combined
 * consensus can be computed without first having to work out which persona
 * belonged to which track. `COUNCIL_PHILOSOPHERS=0` runs the classic jury alone.
 *
 * Each philosopher carries its own wallet env and its own risk limits; a
 * philosopher with no key is skipped exactly like a classic persona, so the track
 * degrades to whatever has been provisioned instead of failing the worker.
 */
const PHILOSOPHERS_ENABLED = process.env.COUNCIL_PHILOSOPHERS !== "0";
const ACTIVE_PHILOSOPHERS: PersonaSpec[] = PHILOSOPHERS_ENABLED
  ? activePhilosophers().filter((p) => {
      const ok = !!process.env[philosopherSecretEnv(p.slug)];
      if (!ok) {
        console.warn(
          `[council] ${p.emoji} ${p.displayName} is missing ${philosopherSecretEnv(p.slug)} — skipping. ` +
          `Run "npm run agents:create-wallets" to provision.`,
        );
      }
      return ok;
    })
  : [];

/** Both juries, in one list for the cycle loop. Track stays readable per persona. */
const ALL_ACTIVE = [...ACTIVE_PERSONAS, ...ACTIVE_PHILOSOPHERS];

if (ALL_ACTIVE.length === 0) {
  console.error("[council] No personas have wallets configured. Exiting.");
  process.exit(1);
}

// ── Fetch claim ───────────────────────────────────────────────────────────────
/**
 * One `get_claim` + roster read, mapped onto the runner's camelCase shape.
 *
 * `readClaimRaw` already retries and answers null for a missing claim (Soroban
 * returns `Err(ClaimNotFound)` rather than throwing), so there is no try/catch
 * left to add here.
 */
async function fetchClaim(claimId: number): Promise<ClaimOnChain | null> {
  const claim = await readClaimRaw(claimId);
  return claim ? toClaimOnChain(claim) : null;
}

/**
 * Pure helper: pick claims that are still joinable at `now`.
 *
 * Extracted so the selection rule can be unit-tested without touching the
 * chain. A claim is joinable when its state is `open` or `active` and its
 * deadline has not yet passed.
 */
export function selectJoinableClaims(claims: ClaimOnChain[], now: number): ClaimOnChain[] {
  return claims.filter(
    (claim) => (claim.state === "open" || claim.state === "active") && claim.deadline > now,
  );
}

// ── Poll loop ─────────────────────────────────────────────────────────────────
async function poll(): Promise<void> {
  const now = Math.floor(Date.now() / 1000);

  let total: number;
  try {
    total = await getClaimCount();
  } catch (err) {
    const depErr = new DependencyFailureError(
      `Failed to read the claim count: ${err instanceof Error ? err.message : String(err)}`,
      "rpc",
      true,
      0,
      err,
    );
    console.warn(`[council] ${describeBackoffError(depErr)}`);
    throw depErr;
  }

  console.log(
    `\n[council] ── Poll at ${new Date().toISOString()} ── ${total} claims, ${ACTIVE_PERSONAS.length} personas`,
  );

  // Shared per-cycle evidence cache — one HTTP fetch per claim no matter
  // how many personas need it. Fresh fetches are also kept in the
  // module-level cache in shared/evidence-cache.ts, so later cycles reuse them
  // while they are inside their category's freshness window.
  const evidenceCache = new Map<number, EvidenceCacheEntry>();
  const peerReasoning = new Map<string, string[]>();
  const ctx: PersonaRunnerContext = {
    contractId: CONTRACT_ID,
    evidenceCache,
    peerReasoning,
  };

  // Pre-load joinable claims so we don't refetch in the inner loop.
  // Batched read: one RPC simulation per BATCH_SIZE ids instead of one per id,
  // so the per-poll cost drops from `total` to `ceil(total / BATCH_SIZE)`.
  const fetched: ClaimOnChain[] = [];
  if (total > 0) {
    const rawClaims = await readClaimsBatch(1, total);
    for (const raw of rawClaims) {
      if (!raw) continue;
      fetched.push(toClaimOnChain(raw));
    }
  }
  const allClaims = selectJoinableClaims(fetched, now);
  // Drop cross-cycle evidence for claims that are no longer joinable.
  pruneEvidenceCache(new Set(allClaims.map((claim) => claim.id)));
  if (allClaims.length === 0) {
    console.log("[council] No joinable claims this round.");
    return;
  }

  // Focus on claims closest to settling — they're the most interesting for
  // the council to weigh in on and keeps LLM-call volume bounded.
  allClaims.sort((a, b) => a.deadline - b.deadline);
  const claims = allClaims.slice(0, MAX_CLAIMS_PER_CYCLE);
  if (claims.length < allClaims.length) {
    console.log(
      `[council] Evaluating ${claims.length} of ${allClaims.length} joinable claims this cycle (deadline-prioritized).`,
    );
  }

  let stakesThisCycle = 0;

  for (const persona of ALL_ACTIVE) {
    for (const claim of claims) {
      try {
        if (PEER_READS_ENABLED && PEER_READS_PER_PERSONA > 0) {
          const reads = await buyPeerReasoning({
            buyer: persona,
            activePersonas: ALL_ACTIVE,
            claimId: claim.id,
            baseUrl: PEER_READS_BASE_URL,
            readsPerPersona: PEER_READS_PER_PERSONA,
            capUsdc: PEER_READ_CAP_USDC,
            delayMs: PEER_READ_DELAY_MS,
          });
          if (reads.length > 0) {
            const formattedReads = reads.map(
              (read) => `${read.sellerName}: ${read.reasoning}`,
            );
            peerReasoning.set(`${claim.id}:${persona.slug}`, formattedReads);
            const paidUsdc = reads.reduce(
              (sum, read) => sum + unitsToUsdc(BigInt(read.pricePaidUnits ?? "0")),
              0,
            );
            console.log(
              `[council:${persona.slug}] bought ${reads.length} peer read(s) for claim #${claim.id} ` +
              `(${paidUsdc.toFixed(6)} USDC)`,
            );
          }
        }
        const receipt = await withBackoff("council", () => runPersonaForClaim(persona, claim, ctx), {
          policy: COUNCIL_BACKOFF,
        });
        if (receipt) stakesThisCycle += 1;
      } catch (err) {
        if (err instanceof BackoffError) {
          console.warn(`[council:${persona.slug}] ${describeBackoffError(err)} on claim #${claim.id}`);
        } else {
          console.error(
            `[council:${persona.slug}] error on claim #${claim.id}:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
      if (DECISION_DELAY_MS > 0) {
        await new Promise((resolve) => setTimeout(resolve, DECISION_DELAY_MS));
      }
    }
  }

  console.log(
    stakesThisCycle > 0
      ? `[council] Cycle complete — ${stakesThisCycle} new stakes submitted.`
      : "[council] Cycle complete — no new stakes.",
  );
}

// ── Entry ─────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log("═══════════════════════════════════════════════");
  console.log("  Mimir Council — 10 AI personas as economic actors");
  console.log(`  Contract       : ${CONTRACT_ID}`);
  console.log(`  Network        : Stellar ${STELLAR_NETWORK}`);
  console.log(`  LLM            : ${activeLLMProvider()} / ${activeLLMModel()} · key=${activeLLMKeyFingerprint()}`);
  console.log(`  Active personas: ${ACTIVE_PERSONAS.length} / ${CLASSIC_PERSONAS.length}`);
  console.log(`  Philosophers   : ${PHILOSOPHERS_ENABLED ? `${ACTIVE_PHILOSOPHERS.length} / ${PHILOSOPHER_PERSONAS.length}` : "off"}`);
  console.log(`  Max claims/cycle: ${MAX_CLAIMS_PER_CYCLE}`);
  console.log(`  Decision gap   : ${DECISION_DELAY_MS / 1000}s`);
  console.log(`  Peer reads     : ${PEER_READS_ENABLED ? `${PEER_READS_PER_PERSONA}/persona via ${PEER_READS_BASE_URL}` : "off"}`);
  console.log(`  Peer read gap  : ${PEER_READ_DELAY_MS / 1000}s`);
  console.log(`  Poll every     : ${POLL_INTERVAL_MS / 1000}s`);
  console.log(`  Poll jitter    : ±${(POLL_JITTER_MS / 1000).toFixed(1)}s`);
  console.log("───────────────────────────────────────────────");

  for (const p of ALL_ACTIVE) {
    // Public-key env differs per track, so ask the right one rather than assuming.
    const addr = (isPhilosopher(p)
      ? process.env[philosopherPublicEnv(p.slug)]
      : process.env[personaPublicEnv(p)])?.split(/\s+#/)[0].trim();
    if (!addr) {
      console.log(`  ${p.emoji} ${p.displayName.padEnd(22)} (no public key configured)`);
      continue;
    }
    // Both balances, because the two now answer different questions: XLM says
    // "can this persona transact at all", USDC says "can it stake".
    const balances = await readAgentBalances(addr).catch(() => null);
    const fees = balances?.xlm === null || balances === null ? "no account" : `${balances.xlm.toFixed(2)} XLM`;
    const bankroll = balances?.usdc == null ? "no USDC" : `${balances.usdc.toFixed(2)} USDC`;
    console.log(
      `  ${p.emoji} ${p.displayName.padEnd(22)} ${addr.slice(0, 5)}…${addr.slice(-4)} · ${fees} · ${bankroll}`,
    );
  }
  console.log("═══════════════════════════════════════════════\n");

  const safePoll = () =>
    reportingPoll("council", "council", POLL_INTERVAL_MS / 1000, poll, { pause: "council_worker" });

  await runWorkerLoop({
    worker: "council",
    intervalMs: POLL_INTERVAL_MS,
    jitterMs: POLL_JITTER_MS,
    cycle: safePoll,
  });
}

main().catch((err) => {
  console.error("[council] fatal:", err);
  process.exit(1);
});
