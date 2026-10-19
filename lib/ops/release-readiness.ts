/**
 * Release readiness checklist — the machine-readable gate list Mimir runs
 * before a funded release.
 *
 * Mimir moves USDC, so "it builds on my machine" is not a release argument.
 * This module turns the release process into data: an ordered registry of
 * gates, each declaring *what it checks*, *how to run it*, and — explicitly —
 * what happens on **failure**, how to **roll back**, which **artifacts** the
 * gate leaves behind, which **secrets** it needs, and what it does to the
 * **environment**. Those five fields are the issue's contract: a gate that
 * cannot describe them is not a gate, it is a hope.
 *
 * Two kinds of gate, and the difference is load-bearing:
 *
 *  - `clean-checkout` — reproducible from a fresh clone with `npm ci` and no
 *    production secrets. Typecheck, forbidden terms, contract tests, the Wasm
 *    build, node tests, the Next build, the secret-free browser smoke, artifact
 *    provenance, the release SBOM, the offline cache-backup verification, the
 *    saved-ledger replay, and this checklist's own self-check. CI runs these on
 *    every pull request, so a release never discovers them late.
 *  - `live-evidence` — needs a real deployment, real traffic, or a human
 *    signature: deployment verification, on-chain smoke, the x402 payment
 *    smoke, the analytics gates, the independent contract audit, the
 *    legal/eligibility review, redundant providers, the funded-feature flag
 *    posture, and the rehearsed rollback. These can never be satisfied from
 *    source code, so they are *recorded* — as evidence, never assumed.
 *
 * Fail-closed rules, each pinned by tests:
 *
 *  1. **A gate with no evidence is not a pass.** Missing evidence is reported
 *     as missing; in `release` mode it is an error. A release record that
 *     simply omits a gate cannot become "ready".
 *  2. **A gate cannot be waived, skipped or marked "n/a".** `status` is exactly
 *     `pass` or `fail`; anything else is refused at parse time, so no money or
 *     deployment control can be silently bypassed.
 *  3. **Evidence is privacy-safe.** A recorded detail or artifact pointer that
 *     looks like a secret (Stellar seed, API key, token, private key, or a URL
 *     with embedded credentials) is refused rather than written into a release
 *     record that gets attached to a release.
 *  4. **The checklist cannot drift.** `releaseReadinessFingerprint()` is a
 *     digest over the registry, and `findDocumentationDrift()` fails when
 *     `docs/RELEASE_READINESS.md` stops describing a gate that exists.
 *
 * This module is pure — no `process.env`, no network, no clock — so the
 * `node:test` suite, the CLI (`scripts/verify-release-readiness.ts`) and CI all
 * evaluate the same bytes and reach the same verdict.
 */

import { createHash } from "node:crypto";

export const RELEASE_READINESS_SCHEMA_VERSION = 1 as const;
export const RELEASE_READINESS_KIND = "mimir-release-readiness" as const;

/** How a gate is satisfied. */
export type ReleaseMode = "develop" | "release";

/** Which part of the release a gate protects. */
export const RELEASE_AREAS = [
  "build",
  "contracts",
  "artifacts",
  "deployment",
  "security",
  "rollback",
  "observability",
  "docs",
] as const;
export type ReleaseArea = (typeof RELEASE_AREAS)[number];

export function isReleaseArea(value: string): value is ReleaseArea {
  return (RELEASE_AREAS as readonly string[]).includes(value);
}

/** Whether a gate can be run from a clean checkout, or needs recorded evidence. */
export const REPRODUCIBILITIES = ["clean-checkout", "live-evidence"] as const;
export type GateReproducibility = (typeof REPRODUCIBILITIES)[number];

/** Secrets a gate may need. `none` is the only value a clean-checkout gate may declare. */
export type GateSecrets = "none" | "operator-supplied";

export interface ReleaseGate {
  /** Stable kebab-case id. Docs, fixtures and commands reference it. */
  id: string;
  /** One line: what the gate proves. */
  title: string;
  area: ReleaseArea;
  /** A blocking gate must pass before a funded release. */
  blocking: boolean;
  reproducibility: GateReproducibility;
  /** The exact command a maintainer runs. */
  command: string;
  /** npm script in package.json, when `command` is an npm script. */
  npmScript?: string;
  /** Repo-relative paths a clean checkout must contain for this gate to run. */
  checkPaths: readonly string[];
  /** Env var *names* the gate reads. Must be empty for clean-checkout gates. */
  env: readonly string[];
  /** What happens when this gate fails. */
  failure: string;
  /** How to undo / roll back. */
  rollback: string;
  /** What the gate leaves behind. */
  produces: string;
  secrets: GateSecrets;
  /** Environment behavior: what must be present, and what must be absent. */
  environment: string;
  /** The money or deployment control this gate protects. */
  protects: string;
}

// ── The registry ─────────────────────────────────────────────────────────────

/**
 * The release readiness checklist, in the order a maintainer runs it: every
 * gate that is reproducible from a clean checkout first, then the gates that
 * need a live deployment or a human signature.
 *
 * Keep ids stable: `docs/RELEASE_READINESS.md`, the committed evidence
 * fixtures and the release record all reference them.
 */
const GATE_DEFINITIONS = [
  {
    id: "typecheck",
    title: "TypeScript compiles across the app, workers, scripts and tests",
    area: "build",
    blocking: true,
    reproducibility: "clean-checkout",
    command: "npm run typecheck",
    npmScript: "typecheck",
    checkPaths: ["tsconfig.json"],
    env: [],
    failure:
      "tsc --noEmit reports a type error and the release stops. A tree that does not compile can ship a route that throws at runtime — including a money path — so this is never downgraded to a warning.",
    rollback:
      "Revert the offending commit and re-run `npm run typecheck`. There is no runtime toggle: a type error is a build-time stop, and loosening tsconfig strictness to hide one is not a rollback.",
    produces: "tsc diagnostics on stdout; nothing is written (--noEmit).",
    secrets: "none",
    environment:
      "Needs only the devDependencies installed by `npm ci`. No .env file, no DATABASE_URL, no Stellar credentials.",
    protects:
      "Every funded route and worker: a type error in a stake, payout or settlement path is caught before deploy.",
  },
  {
    id: "forbidden-terms",
    title: "Forbidden-terms guardrail passes",
    area: "security",
    blocking: true,
    reproducibility: "clean-checkout",
    command: "npm run check:terms",
    npmScript: "check:terms",
    checkPaths: ["scripts/check-forbidden-terms.mjs"],
    env: [],
    failure:
      "A tracked file mentions a pre-Stellar chain name, a bespoke payment header, or a secret-shaped literal. The check fails the build with the file and line, before anything is deployed.",
    rollback:
      "Remove the offending token and re-run. Adding a file to SKIP_FILES is allowed only for a file that deliberately holds a synthetic secret sample (the existing `tests/node/x402-fixtures.ts` precedent), never to silence a real leak.",
    produces: "A per-file, per-line hit list on stderr; nothing is uploaded.",
    secrets: "none",
    environment:
      "Runs offline over `git ls-files`; no network, no credentials.",
    protects:
      "Chain and payment-scheme identity: the app must not drift back to a non-Stellar rail or a hand-rolled payment header.",
  },
  {
    id: "contract-tests",
    title: "Soroban contract test suite passes",
    area: "contracts",
    blocking: true,
    reproducibility: "clean-checkout",
    command: "npm run test:contracts",
    npmScript: "test:contracts",
    checkPaths: ["contracts-soroban/Cargo.toml"],
    env: [],
    failure:
      "A Rust test fails: escrow conservation, payout maths, fee policy, challenger pull-payouts or a state-machine guard regressed. The release stops; the failing test names the invariant.",
    rollback:
      "Revert the contract change and re-run. A contract rollback on chain is a redeploy of the previously pinned Wasm (see `rollback-rehearsal`), never an in-place edit of live storage.",
    produces: "cargo test output; no on-chain transaction is submitted.",
    secrets: "none",
    environment:
      "Needs the Rust toolchain with the wasm32v1-none target. No RPC endpoint, no seeds, no DATABASE_URL.",
    protects:
      "The code that custodies and moves USDC: escrow, settlement, fees and payouts.",
  },
  {
    id: "contract-build",
    title: "Release Wasm builds for both contracts",
    area: "artifacts",
    blocking: true,
    reproducibility: "clean-checkout",
    command:
      "cargo build --manifest-path contracts-soroban/Cargo.toml --release --target wasm32v1-none",
    checkPaths: [
      "contracts-soroban/Cargo.toml",
      "deploy/contract-artifacts.manifest.json",
    ],
    env: [],
    failure:
      "The release build fails, so there is no artifact to pin or deploy. Nothing downstream may proceed: provenance, deployment verification and on-chain smoke all consume these bytes.",
    rollback:
      "Fix the build or revert the change, then rebuild and re-pin. Never deploy a Wasm whose digest is not the one the manifest pins.",
    produces:
      "contracts-soroban/target/wasm32v1-none/release/mimir_market.wasm and mimir_squad.wasm (gitignored build output).",
    secrets: "none",
    environment:
      "Rust toolchain with the wasm32v1-none target; fully offline once crates are vendored by cargo.",
    protects:
      "Artifact provenance: the shipped Wasm must be the one that was reviewed and pinned.",
  },
  {
    id: "node-tests",
    title: "Node test suite passes",
    area: "build",
    blocking: true,
    reproducibility: "clean-checkout",
    command: "npm run test:smoke",
    npmScript: "test:smoke",
    checkPaths: ["scripts/run-node-tests.mjs"],
    env: [],
    failure:
      "A node test fails. The runner prints the failing file and assertion; treat it as a release stop, not a flake to re-run.",
    rollback:
      "Revert the change that broke it, or fix the code the test pins. Never delete or `skip` a test to go green.",
    produces: "TAP output on stdout; no artifact is written.",
    secrets: "none",
    environment:
      "`npm ci` only. Tests that need a database or RPC skip themselves with an explicit reason rather than pretending to pass.",
    protects:
      "Money maths, fail-closed API behavior, rate limits, privacy scrubbing and every other invariant the suite pins.",
  },
  {
    id: "app-build",
    title: "Production Next.js build succeeds",
    area: "build",
    blocking: true,
    reproducibility: "clean-checkout",
    command: "npm run build",
    npmScript: "build",
    checkPaths: ["next.config.js"],
    env: [],
    failure:
      "`next build` fails, so there is no deployable bundle. A build that only succeeds with a developer's local .env is a failure of this gate, not a pass.",
    rollback:
      "Revert the change and rebuild, or redeploy the previous production build from the host's deployment history.",
    produces: ".next/ build output (gitignored).",
    secrets: "none",
    environment:
      "No secrets and no DATABASE_URL are required: the app must build in its unconfigured, fail-closed state. The browser smoke job proves exactly that.",
    protects:
      "Deployment integrity: what CI builds is what ships, and it builds without production credentials.",
  },
  {
    id: "browser-smoke",
    title: "Secret-free browser smoke passes",
    area: "deployment",
    blocking: true,
    reproducibility: "clean-checkout",
    command: "npm run smoke:browser",
    npmScript: "smoke:browser",
    checkPaths: ["scripts/run-browser-smoke.mjs", "playwright.config.ts"],
    env: [],
    failure:
      "The Playwright suite fails against a build served with a strict secret-free env allowlist. Health must be 503 critical with `db.unconfigured`, the arena feed empty, and money paths gated behind a connect control.",
    rollback:
      "Revert the page or env-read that broke the unconfigured state, then re-run. The runner tears down cleanly, so the same command always reproduces what CI ran.",
    produces:
      "playwright-report/ and test-results/ (uploaded for 7 days by CI on failure only).",
    secrets: "none",
    environment:
      "The harness moves every .env* file aside and builds with only `buildSmokeEnv()` keys. A new secret-shaped variable must NOT be added to that allowlist.",
    protects:
      "The fail-closed posture of the shipped app: no page may require a live credential or a live deployment to render safely.",
  },
  {
    id: "artifact-provenance",
    title: "Contract Wasm digests match the committed pins",
    area: "artifacts",
    blocking: true,
    reproducibility: "clean-checkout",
    command: "npm run verify:artifacts -- --mode=release --require-built",
    npmScript: "verify:artifacts",
    checkPaths: ["deploy/contract-artifacts.manifest.json"],
    env: [],
    failure:
      "A Wasm is missing, unpinned, or its sha256 differs from `deploy/contract-artifacts.manifest.json`. Release mode fails closed: an unpinned artifact is an error, not a warning.",
    rollback:
      "Refuse to deploy or roll back to the mismatched build. Re-pin only after an intentional rebuild has been reviewed, with `npm run verify:artifacts -- --write-pins`.",
    produces: "A digest list per artifact id; no network calls, no RPC.",
    secrets: "none",
    environment:
      "Reads the manifest and the built Wasm from disk. Offline and reproducible from a clean checkout after the contract build.",
    protects:
      "The exact bytes that hold user funds: an unreviewed or tampered Wasm must never reach a funded deployment.",
  },
  {
    id: "release-sbom",
    title: "Release SBOM generates from the committed lockfile",
    area: "artifacts",
    blocking: true,
    reproducibility: "clean-checkout",
    command: "npm run sbom:release",
    npmScript: "sbom:release",
    checkPaths: ["package-lock.json", "scripts/generate-release-sbom.mjs"],
    env: [],
    failure:
      "The lockfile is missing, corrupt, an unsupported lockfileVersion, or yields zero components. Generation fails closed and nothing is uploaded — an empty SBOM is never published.",
    rollback:
      "Re-run `npm install` to refresh package-lock.json, or re-run the release-sbom workflow (`--clobber`) / delete the bad release asset.",
    produces:
      "sbom/mimir.cdx.json locally; `mimir-<tag>.cdx.json` attached to the GitHub release by .github/workflows/release-sbom.yml.",
    secrets: "none",
    environment:
      "Reads package-lock.json at the release tag only. No registry calls, no deployment credentials.",
    protects:
      "Dependency transparency for operators: every shipped tag must be inventariable.",
  },
  {
    id: "cache-backup-verify",
    title: "Offline cache-backup verification passes",
    area: "rollback",
    blocking: true,
    reproducibility: "clean-checkout",
    command:
      "npm run verify:cache-backup -- tests/fixtures/cache-backup/valid.json",
    npmScript: "verify:cache-backup",
    checkPaths: [
      "tests/fixtures/cache-backup/valid.json",
      "lib/ops/cache-backup.ts",
    ],
    env: [],
    failure:
      "The committed archive fails schema, checksum or privacy verification. Fail-closed findings: BACKUP_INVALID, BACKUP_KIND_MISMATCH, BACKUP_SCHEMA_UNSUPPORTED, BACKUP_MISSING_TABLE, BACKUP_UNKNOWN_TABLE, BACKUP_EMPTY, BACKUP_CHECKSUM_MISMATCH, BACKUP_PRIVATE_CONTENT_LEAK.",
    rollback:
      "Do not restore the archive. Regenerate it from a healthy database, or re-warm the read index from chain — the chain stays the source of truth and is never written by a restore.",
    produces:
      "A pass/fail verdict plus the archive checksum; no database or network access.",
    secrets: "none",
    environment:
      "No DATABASE_URL, no Soroban RPC, no seeds: a pure function of the archive bytes, reproducible anywhere.",
    protects:
      "The restore path itself: a backup that cannot be verified offline cannot be trusted near money-adjacent state.",
  },
  {
    id: "ledger-fixture-replay",
    title: "Saved ledger fixture replays to the reviewed fingerprint",
    area: "contracts",
    blocking: true,
    reproducibility: "clean-checkout",
    command: "npm run check:ledger-fixture",
    npmScript: "check:ledger-fixture",
    checkPaths: [
      "fixtures/ledger/funded-market-v1.json",
      "lib/ops/ledger-fixture.ts",
    ],
    env: [],
    failure:
      "Replay is refused: partial capture, orphan events, conflicting ledger positions, unsafe (non-string) money values, or a fingerprint that differs from the reviewed fixture.",
    rollback:
      "Roll the projection and the fixture back together, re-run the release checks, and redeploy the sync worker. Never copy fixture rows into production.",
    produces:
      "One JSON reconciliation artifact on stdout (ledger bounds, fingerprint, resume cursor, deterministic rows).",
    secrets: "none",
    environment:
      "Offline and read-only: no Postgres write, no live cursor, no RPC, no .env.",
    protects:
      "Chain-first accounting: the read index must remain a pure fold of chain events, provable without a database.",
  },
  {
    id: "release-readiness-checklist",
    title: "This checklist is coherent and documented",
    area: "docs",
    blocking: true,
    reproducibility: "clean-checkout",
    command: "npm run verify:release-readiness",
    npmScript: "verify:release-readiness",
    checkPaths: ["docs/RELEASE_READINESS.md", "package.json"],
    env: [],
    failure:
      "A gate is structurally invalid, its npm script is missing from package.json, a declared path is absent, or docs/RELEASE_READINESS.md no longer describes every gate id and command. The checklist fails instead of drifting.",
    rollback:
      "Restore the missing script, path or doc section, or update the doc in the same pull request that changes the gate. Never silence the check to ship.",
    produces:
      "The printed checklist, and — with `--out` — a deterministic JSON release record (no timestamps unless `--stamp`).",
    secrets: "none",
    environment:
      "Reads only tracked repo files. Never reads .env, never requires production credentials.",
    protects:
      "The release process itself: the checklist a maintainer follows and the checklist CI enforces cannot diverge.",
  },

  // ── Gates that need a live deployment or a human signature ────────────────
  {
    id: "deployment-verification",
    title: "Deployed contracts match configuration and the local build",
    area: "deployment",
    blocking: true,
    reproducibility: "live-evidence",
    command: "npm run verify:deployment",
    npmScript: "verify:deployment",
    checkPaths: ["scripts/verify-deployment.ts"],
    env: [
      "NEXT_PUBLIC_STELLAR_MARKET_CONTRACT_ID",
      "NEXT_PUBLIC_STELLAR_SQUAD_CONTRACT_ID",
      "NEXT_PUBLIC_STELLAR_USDC_SAC_ID",
      "NEXT_PUBLIC_STELLAR_RPC_URL",
      "NEXT_PUBLIC_STELLAR_HORIZON_URL",
      "NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE",
      "SELLER_ADDRESS",
      "ORACLE_ADDRESS",
    ],
    failure:
      "An on-chain value (owner, oracle, USDC SAC, fee policy, WASM hash) disagrees with the configured environment, or the RPC reports an unhealthy or wrong-passphrase network. Read-only: nothing is submitted.",
    rollback:
      "Stop the rollout. Redeploy from the previously pinned Wasm and restore the env, then re-run verification. A wrong fee policy or oracle address is a deployment rollback, not a runtime flag.",
    produces:
      "A verification log with the compared values; retain the contract ids, the deployed WASM hash, ledger sequences and transaction hashes.",
    secrets: "operator-supplied",
    environment:
      "Needs the deployment env (contract ids, RPC/Horizon endpoints, public G… addresses). Never needs a seed: the verifier only reads.",
    protects:
      "The live money configuration: fee policy, oracle authority and the USDC asset the contracts actually move.",
  },
  {
    id: "onchain-smoke",
    title: "On-chain smoke (resolve + squad) passes on Testnet",
    area: "deployment",
    blocking: true,
    reproducibility: "live-evidence",
    command: "npm run smoke:onchain --resolve --squad",
    npmScript: "smoke:onchain",
    checkPaths: ["scripts/onchain-smoke.ts"],
    env: [
      "NEXT_PUBLIC_STELLAR_MARKET_CONTRACT_ID",
      "NEXT_PUBLIC_STELLAR_SQUAD_CONTRACT_ID",
      "NEXT_PUBLIC_STELLAR_USDC_SAC_ID",
      "NEXT_PUBLIC_STELLAR_RPC_URL",
      "NEXT_PUBLIC_STELLAR_HORIZON_URL",
      "STELLAR_ORACLE_SECRET",
    ],
    failure:
      "A create → challenge → resolve → refund / pull-payout cycle fails against the live deployment. Funded flows are blocked until the smoke passes.",
    rollback:
      "Pause settlement (`MIMIR_PAUSE_ORACLE_SETTLEMENT=1`), redeploy the previous pinned Wasm, and re-run the smoke before resuming.",
    produces:
      "Transaction hashes and resolve / refund / pull-payout evidence; retain them with the release record.",
    secrets: "operator-supplied",
    environment:
      "Needs the oracle's signing seed and the deployed contract ids. Run against Testnet only; never against mainnet funds.",
    protects:
      "The full settlement lifecycle end to end, including the pull-based challenger payout path.",
  },
  {
    id: "x402-payment-smoke",
    title: "x402 payment scheme smoke passes",
    area: "security",
    blocking: true,
    reproducibility: "live-evidence",
    command: "npm run smoke:x402",
    npmScript: "smoke:x402",
    checkPaths: ["scripts/x402-stellar-smoke.ts"],
    env: ["NEXT_PUBLIC_STELLAR_HORIZON_URL", "X402_NETWORK", "SELLER_ADDRESS"],
    failure:
      "A paid endpoint refuses a valid proof, or accepts one it cannot verify off Horizon. Unverified payments are never recorded as revenue, so the failure is a refusal, not a silent sale.",
    rollback:
      "Pause selling (`MIMIR_PAUSE_X402_SELLING=1`) — reads and settlement keep working — then restore the provider endpoint and re-run the smoke.",
    produces: "Payment hashes and the verification reasons observed.",
    secrets: "operator-supplied",
    environment:
      "Needs the seller address and a funded buyer on Testnet. No facilitator and no HTTP third party is involved.",
    protects:
      "Paid revenue: a proof must be read back off the ledger or the request is refused.",
  },
  {
    id: "analytics-gates",
    title: "Analytics gates pass on a real traffic export",
    area: "observability",
    blocking: true,
    reproducibility: "live-evidence",
    command: "npm run verify:analytics -- <export.json>",
    npmScript: "verify:analytics",
    checkPaths: ["scripts/check-analytics-gates.ts"],
    env: [],
    failure:
      "The export cannot show measurable create/stake funnels or 99% required-field completeness. The launch gate stays open; it is not closed by synthetic data.",
    rollback:
      "Not a runtime rollback: re-collect a longer, non-internal export and re-run. Fix instrumentation before claiming the funnel.",
    produces: "A gate verdict per funnel metric over the supplied export file.",
    secrets: "none",
    environment:
      "Needs a real (non-internal) analytics export as a file. No production API key is read by the checker itself.",
    protects:
      "Product claims about usage: nothing funded ships on the strength of an unmeasured funnel.",
  },
  {
    id: "contract-audit",
    title: "Independent audit of both Soroban contracts is attached",
    area: "security",
    blocking: true,
    reproducibility: "live-evidence",
    command:
      "Attach the independent audit of contracts-soroban/mimir-market and contracts-soroban/mimir-squad",
    checkPaths: [
      "contracts-soroban/mimir-market/src",
      "contracts-soroban/mimir-squad/src",
    ],
    env: [],
    failure:
      "No independent audit exists for the Soroban contracts. The prior EVM review does not carry over, so the gate stays open and funded features stay off.",
    rollback:
      "Not reversible by configuration: if an audit finding invalidates a control, revert to the last audited build and keep the money flags off.",
    produces:
      "The audit report and the maintainers' written disposition of each finding.",
    secrets: "none",
    environment:
      "Human review. The audit must cover Soroban-specific surface: authorization sites, storage TTL/archival, ledger-entry footprint under adversarial input, contract-account callers.",
    protects:
      "Custody of user funds in the two contracts that hold escrow and pool balances.",
  },
  {
    id: "legal-eligibility-review",
    title: "Legal, custody, sanctions/eligibility and mainnet review complete",
    area: "security",
    blocking: true,
    reproducibility: "live-evidence",
    command:
      "Record written product, legal and eligibility approval for the funded surfaces",
    checkPaths: ["docs/LAUNCH_GATE_STATUS.md"],
    env: [],
    failure:
      "Approval is missing, so the corresponding money-moving feature flag stays off. This gate is closed by named approvers, never by code.",
    rollback:
      "Keep the feature flag off. Rolling back an approval means turning the funded surface back off, which is the shipped default.",
    produces: "Signed approvals and the eligibility policy they reference.",
    secrets: "none",
    environment: "Human review; no technical environment required.",
    protects:
      "Regulatory and custody posture for anything that holds or moves user funds.",
  },
  {
    id: "redundant-providers",
    title: "Redundant Soroban RPC and Horizon providers are configured",
    area: "deployment",
    blocking: true,
    reproducibility: "live-evidence",
    command:
      "Configure and monitor a second RPC and Horizon provider in the deploy env",
    checkPaths: ["lib/stellar.ts"],
    env: ["NEXT_PUBLIC_STELLAR_RPC_URL", "NEXT_PUBLIC_STELLAR_HORIZON_URL"],
    failure:
      "Only the rate-limited public endpoints are configured, so a provider outage makes chain reads — and therefore money paths — unavailable with no fallback.",
    rollback:
      "Restore the primary provider; reads resume without a deploy. A provider failover is a configuration change, never a code change.",
    produces:
      "Provider configuration plus the monitoring evidence that failover was exercised.",
    secrets: "operator-supplied",
    environment:
      "Deployment env only. Provider URLs are public endpoints, not credentials.",
    protects:
      "Availability of chain reads, which every stake, settlement and verification path depends on.",
  },
  {
    id: "funded-feature-flags",
    title: "Funded features remain off until their evidence is attached",
    area: "security",
    blocking: true,
    reproducibility: "live-evidence",
    command:
      "Confirm the funded BYOA / copy-trading / basket flags are 0 and the pause controls are 1 in the deploy env",
    checkPaths: ["lib/ops/flags.ts"],
    env: ["MIMIR_FEATURE_COPY_TRADING", "MIMIR_PAUSE_COPY_EXECUTION"],
    failure:
      "A funded feature is enabled without its audit, legal and eligibility evidence. That is a release-blocking misconfiguration, not a configuration choice.",
    rollback:
      "Set the flag to 0 (and the matching pause to 1) in the deploy env — an env change, no redeploy — and confirm the funded path refuses.",
    produces: "The recorded flag posture for the release record.",
    secrets: "none",
    environment:
      "Deployment env only; the flag names are recorded, never their secret-shaped neighbours.",
    protects:
      "Funded-feature blast radius: off by default is the shipped posture until evidence exists.",
  },
  {
    id: "rollback-rehearsal",
    title: "Rollback runbook has been rehearsed",
    area: "rollback",
    blocking: true,
    reproducibility: "live-evidence",
    command:
      "Rehearse the cache restore dry-run and the previous-pinned-Wasm redeploy",
    checkPaths: ["docs/AGENT_INCIDENT_RUNBOOK.md"],
    env: [],
    failure:
      "Nobody has executed the rollback path for this release, so an incident would be handled by improvisation while funds are exposed.",
    rollback:
      "This gate *is* the rollback: restoring a verified archive, re-warming the index from chain, or redeploying the previously pinned Wasm. Rehearse it before release, not during the incident.",
    produces: "A dated rehearsal note naming who ran it and what was restored.",
    secrets: "none",
    environment:
      "Staging or Testnet. The restore dry-run needs a DATABASE_URL for a non-production database only.",
    protects:
      "Recovery time: the read index is disposable and rebuildable from chain, but only if that has been practised.",
  },
  {
    id: "load-baseline",
    title: "Load baselines recorded for verification and rate limiting",
    area: "observability",
    blocking: false,
    reproducibility: "live-evidence",
    command: "npm run load:x402 && npm run load:rate-limit",
    npmScript: "load:x402",
    checkPaths: ["scripts/load-x402-verify.ts", "scripts/load-rate-limit.ts"],
    env: [],
    failure:
      "No baseline exists, so a regression in verification latency or rate-limit behaviour would be invisible until it affects paid traffic.",
    rollback:
      "Not a rollback gate: re-run the load scripts after a performance fix and compare against the recorded baseline.",
    produces:
      "Throughput and latency numbers from the two offline load scripts.",
    secrets: "none",
    environment:
      "Offline: fixture-driven, no network and no production credentials.",
    protects:
      "Paid-endpoint capacity: a verification path that slows down under load is a revenue and availability risk.",
  },
] as const satisfies readonly ReleaseGate[];

/** Stable ids of every gate in the checklist. */
export type ReleaseGateId = (typeof GATE_DEFINITIONS)[number]["id"];

/**
 * The registry, widened to the interface so optional fields (such as
 * `npmScript`, which only some gates have) are visible to callers.
 */
export const RELEASE_GATES: readonly ReleaseGate[] =
  Object.freeze(GATE_DEFINITIONS);

export const RELEASE_GATE_IDS: readonly ReleaseGateId[] = Object.freeze(
  RELEASE_GATES.map((gate) => gate.id) as ReleaseGateId[],
);

export function isReleaseGateId(value: string): value is ReleaseGateId {
  return (RELEASE_GATE_IDS as readonly string[]).includes(value);
}

/** Gates a clean checkout can run without production secrets. */
export function cleanCheckoutGates(): readonly ReleaseGate[] {
  return RELEASE_GATES.filter(
    (gate) => gate.reproducibility === "clean-checkout",
  );
}

/** Gates that need a live deployment or a human signature. */
export function liveEvidenceGates(): readonly ReleaseGate[] {
  return RELEASE_GATES.filter(
    (gate) => gate.reproducibility === "live-evidence",
  );
}

/**
 * Resolve a gate by id. Fails closed: an unknown id throws rather than
 * returning a defaulted gate that a caller could treat as satisfied.
 */
export function getReleaseGate(id: string): ReleaseGate {
  const gate = RELEASE_GATES.find((candidate) => candidate.id === id);
  if (!gate) {
    throw new Error(
      `unknown release gate "${id}" — known gates: ${RELEASE_GATE_IDS.join(", ")}`,
    );
  }
  return gate;
}

// ── Registry validation ──────────────────────────────────────────────────────

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Structural problems in the registry, one per line. An empty array means the
 * checklist is internally consistent and safe to publish.
 */
export function validateReleaseReadinessRegistry(): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const gate of RELEASE_GATES) {
    if (!KEBAB.test(gate.id)) {
      problems.push(`gate id "${gate.id}" must be kebab-case`);
    }
    if (seen.has(gate.id)) {
      problems.push(`duplicate gate id "${gate.id}"`);
    }
    seen.add(gate.id);

    if (gate.title.trim() === "")
      problems.push(`${gate.id}: title is required`);
    if (!isReleaseArea(gate.area)) {
      problems.push(`${gate.id}: "${gate.area}" is not a RELEASE_AREAS value`);
    }
    if (gate.command.trim() === "")
      problems.push(`${gate.id}: command is required`);
    if (
      gate.npmScript !== undefined &&
      !gate.command.includes(gate.npmScript)
    ) {
      problems.push(
        `${gate.id}: command does not run npm script "${gate.npmScript}"`,
      );
    }
    if (gate.reproducibility === "clean-checkout") {
      // A gate that claims to be reproducible from a clean checkout must not
      // need credentials or environment it does not have.
      if (gate.secrets !== "none") {
        problems.push(
          `${gate.id}: clean-checkout gates must declare secrets "none" (got "${gate.secrets}")`,
        );
      }
      if (gate.env.length > 0) {
        problems.push(
          `${gate.id}: clean-checkout gates must not read env vars (got ${gate.env.join(", ")})`,
        );
      }
    }
    for (const key of [
      "failure",
      "rollback",
      "produces",
      "environment",
      "protects",
    ] as const) {
      if (gate[key].trim().length < 20) {
        problems.push(
          `${gate.id}: ${key} must be described explicitly (${gate[key].trim().length} chars)`,
        );
      }
    }
    for (const p of gate.checkPaths) {
      if (p.startsWith("/") || p.includes("..")) {
        problems.push(
          `${gate.id}: checkPaths must be repo-relative (got "${p}")`,
        );
      }
    }
    for (const key of gate.env) {
      if (!/^[A-Z0-9_]+$/.test(key)) {
        problems.push(
          `${gate.id}: env name "${key}" must be an env var name, not a value`,
        );
      }
    }
  }

  if (cleanCheckoutGates().length === 0) {
    problems.push(
      "no clean-checkout gates: the checklist would not be reproducible",
    );
  }
  if (liveEvidenceGates().length === 0) {
    problems.push(
      "no live-evidence gates: the checklist would ignore the launch gate",
    );
  }
  return problems;
}

// ── Documentation drift ──────────────────────────────────────────────────────

/**
 * Does `docs/RELEASE_READINESS.md` still describe this checklist?
 *
 * The doc is the human-facing half of the gate list, so a gate added to the
 * registry without its doc entry (or a command that changed) is a release
 * blocker: a maintainer following the doc would skip a gate CI enforces, or
 * run a command that no longer exists.
 */
export function findDocumentationDrift(doc: string): string[] {
  const problems: string[] = [];
  if (doc.trim() === "") {
    return ["docs/RELEASE_READINESS.md is empty"];
  }
  for (const gate of RELEASE_GATES) {
    if (!new RegExp(`\\b${gate.id}\\b`).test(doc)) {
      problems.push(
        `docs/RELEASE_READINESS.md does not mention gate "${gate.id}"`,
      );
    }
    if (!doc.includes(gate.command)) {
      problems.push(
        `docs/RELEASE_READINESS.md does not document the command for "${gate.id}": ${gate.command}`,
      );
    }
  }
  return problems;
}

// ── Fingerprint ──────────────────────────────────────────────────────────────

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object")
    return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
    );
  return `{${entries.join(",")}}`;
}

/**
 * Digest over the gate list: ids, titles, areas, blocking flags,
 * reproducibility and commands. Pinned by a regression test so the checklist
 * cannot change silently — a gate added, removed or re-scoped shows up as a
 * fingerprint change in the same pull request.
 */
export function releaseReadinessFingerprint(): string {
  const payload = RELEASE_GATES.map((gate) => ({
    id: gate.id,
    title: gate.title,
    area: gate.area,
    blocking: gate.blocking,
    reproducibility: gate.reproducibility,
    command: gate.command,
  }));
  return createHash("sha256")
    .update(canonicalJson(payload), "utf8")
    .digest("hex");
}

// ── Evidence ─────────────────────────────────────────────────────────────────

/** The only two statuses a gate may carry. Anything else is refused. */
export const GATE_STATUSES = ["pass", "fail"] as const;
export type GateStatus = (typeof GATE_STATUSES)[number];

/** What a gate looks like after evaluation: a recorded status, or nothing. */
export type EvaluatedGateStatus = GateStatus | "missing";

export interface ReleaseGateEvidence {
  status: GateStatus;
  /** Privacy-safe, secret-free detail (validated — see `looksLikeSecret`). */
  detail?: string;
  /** Pointer to the retained artifact: a path, a URL or a transaction hash. */
  artifact?: string;
}

export interface ReleaseEvidence {
  schemaVersion: typeof RELEASE_READINESS_SCHEMA_VERSION;
  kind: typeof RELEASE_READINESS_KIND;
  results: Record<string, ReleaseGateEvidence>;
}

const EVIDENCE_KEYS = new Set(["status", "detail", "artifact"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

/**
 * Parse a release evidence record.
 *
 * Throws on anything that could let a gate pass without being run: an unknown
 * gate id, a status other than `pass`/`fail` (including `waived`, `skipped`,
 * `n/a` and `pending`), an unexpected per-gate key, or an empty result set. A
 * maintainer who could not run a gate simply leaves it out, and the evaluation
 * reports it as missing.
 */
export function parseReleaseEvidence(raw: unknown): ReleaseEvidence {
  const doc = isPlainObject(raw) ? raw : null;
  if (!doc) {
    throw new Error("release evidence must be a JSON object");
  }
  if (doc.kind !== RELEASE_READINESS_KIND) {
    throw new Error(`kind must be "${RELEASE_READINESS_KIND}"`);
  }
  if (doc.schemaVersion !== RELEASE_READINESS_SCHEMA_VERSION) {
    throw new Error(
      `schemaVersion must be ${RELEASE_READINESS_SCHEMA_VERSION}`,
    );
  }
  const results = isPlainObject(doc.results) ? doc.results : null;
  if (!results) {
    throw new Error("results must be an object keyed by gate id");
  }
  const ids = Object.keys(results);
  if (ids.length === 0) {
    throw new Error(
      "results is empty — refusing to treat an empty record as release evidence",
    );
  }

  const parsed: Record<string, ReleaseGateEvidence> = {};
  for (const id of ids) {
    if (!isReleaseGateId(id)) {
      throw new Error(
        `unknown release gate "${id}" — known gates: ${RELEASE_GATE_IDS.join(", ")}`,
      );
    }
    const entry = results[id];
    if (!isPlainObject(entry)) {
      throw new Error(`results.${id} must be an object`);
    }
    for (const key of Object.keys(entry)) {
      if (!EVIDENCE_KEYS.has(key)) {
        throw new Error(
          `results.${id}.${key} is not allowed — release evidence records pass/fail only, ` +
            "it cannot waive, skip or bypass a gate",
        );
      }
    }
    const status = entry.status;
    if (status !== "pass" && status !== "fail") {
      throw new Error(
        `results.${id}.status must be "pass" or "fail" (got ${JSON.stringify(status)}) — ` +
          "a gate that was not run is missing evidence, not a passing status",
      );
    }
    const evidence: ReleaseGateEvidence = { status };
    if (entry.detail !== undefined)
      evidence.detail = asString(entry.detail, `results.${id}.detail`);
    if (entry.artifact !== undefined) {
      evidence.artifact = asString(entry.artifact, `results.${id}.artifact`);
    }
    parsed[id] = evidence;
  }

  return {
    schemaVersion: RELEASE_READINESS_SCHEMA_VERSION,
    kind: RELEASE_READINESS_KIND,
    results: parsed,
  };
}

// ── Privacy ──────────────────────────────────────────────────────────────────

/**
 * Secret *shapes* — deliberately written so the patterns themselves never
 * match the forbidden-terms guardrail (scripts/check-forbidden-terms.mjs).
 * A release record gets attached to a release and copied into chat, so a
 * value that merely looks like a credential is refused rather than stored.
 */
const SECRET_SHAPES: ReadonlyArray<
  readonly [string, (value: string) => boolean]
> = [
  [
    "stellar-secret-seed",
    (value) =>
      value.length === 56 && value.startsWith("S") && /^[A-Z2-7]+$/.test(value),
  ],
  ["api-key", (value) => /\b(?:sk|rk)-[A-Za-z0-9_-]{16,}/.test(value)],
  ["github-token", (value) => /\bgh[pousr]_[A-Za-z0-9]{20,}/.test(value)],
  ["posthog-key", (value) => /\bphc_[A-Za-z0-9]{20,}/.test(value)],
  ["aws-access-key", (value) => /\bAKIA[0-9A-Z]{16}\b/.test(value)],
  ["private-key", (value) => /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)],
  [
    "url-with-embedded-credentials",
    (value) => /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s:@]+@/.test(value),
  ],
];

/**
 * Label the secret shape a value carries, or null when it looks clean.
 * Used on every string in an evidence record before it is accepted.
 */
export function looksLikeSecret(value: string): string | null {
  for (const [label, test] of SECRET_SHAPES) {
    if (test(value)) return label;
  }
  return null;
}

/** Collect the secret-shaped strings in an evidence record, gate id first. */
export function findSecretShapedEvidence(
  evidence: ReleaseEvidence,
): Array<{ gateId: string; field: string; shape: string }> {
  const hits: Array<{ gateId: string; field: string; shape: string }> = [];
  for (const [gateId, entry] of Object.entries(evidence.results)) {
    for (const field of ["detail", "artifact"] as const) {
      const value = entry[field];
      if (typeof value !== "string") continue;
      const shape = looksLikeSecret(value);
      if (shape) hits.push({ gateId, field, shape });
    }
  }
  return hits;
}

// ── Evaluation ───────────────────────────────────────────────────────────────

export type ReleaseFindingCode =
  | "EVIDENCE_INVALID"
  | "EVIDENCE_UNKNOWN_GATE"
  | "EVIDENCE_SECRET_SHAPED"
  | "GATE_FAILED"
  | "GATE_MISSING_EVIDENCE"
  | "GATE_NOT_EVIDENCED";

export interface ReleaseFinding {
  code: ReleaseFindingCode;
  severity: "error" | "warning";
  gateId?: string;
  message: string;
}

export interface EvaluatedGate {
  id: ReleaseGateId;
  title: string;
  area: ReleaseArea;
  blocking: boolean;
  reproducibility: GateReproducibility;
  status: EvaluatedGateStatus;
  command: string;
  detail?: string;
  artifact?: string;
}

export interface ReleaseReadinessReport {
  /** No error-severity findings. In release mode this equals `releaseReady`. */
  ok: boolean;
  mode: ReleaseMode;
  /** True only when every gate in the registry passed. */
  releaseReady: boolean;
  fingerprint: string;
  gates: EvaluatedGate[];
  findings: ReleaseFinding[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    missing: number;
    blockingMissing: number;
  };
}

export interface EvaluateOptions {
  mode?: ReleaseMode;
}

/**
 * Evaluate recorded evidence against the checklist.
 *
 * `evidence === null` means "nothing recorded" — every gate is reported as
 * missing, which is the honest answer for a clean checkout that has not run
 * the live-evidence gates.
 *
 * Fail-closed:
 *  - a recorded `fail` is always an error;
 *  - a gate with no evidence is reported as *missing*, never as passing. In
 *    develop mode that is a warning (CI runs each offline gate as its own
 *    step, and the live-evidence gates simply have not been run yet); in
 *    release mode a missing blocking gate is an error, so a release can never
 *    be declared ready by omitting the gates that need a deployment.
 */
export function evaluateReleaseReadiness(
  evidence: ReleaseEvidence | null,
  options: EvaluateOptions = {},
): ReleaseReadinessReport {
  const mode: ReleaseMode = options.mode ?? "develop";
  const findings: ReleaseFinding[] = [];
  const gates: EvaluatedGate[] = [];
  let passed = 0;
  let failed = 0;
  let missing = 0;
  let blockingMissing = 0;

  if (evidence) {
    for (const hit of findSecretShapedEvidence(evidence)) {
      findings.push({
        code: "EVIDENCE_SECRET_SHAPED",
        severity: "error",
        gateId: hit.gateId,
        message:
          `evidence for "${hit.gateId}" carries a value shaped like a ${hit.shape} in ` +
          `"${hit.field}" — release records are published, so secrets are refused, not redacted`,
      });
    }
  }

  for (const gate of RELEASE_GATES) {
    const recorded = evidence?.results[gate.id];
    const evaluated: EvaluatedGate = {
      id: gate.id as ReleaseGateId,
      title: gate.title,
      area: gate.area,
      blocking: gate.blocking,
      reproducibility: gate.reproducibility,
      status: "missing",
      command: gate.command,
    };

    if (!recorded) {
      missing += 1;
      if (gate.blocking) blockingMissing += 1;
      const releaseMode = mode === "release";
      const offline = gate.reproducibility === "clean-checkout";
      findings.push({
        code:
          releaseMode && gate.blocking
            ? "GATE_MISSING_EVIDENCE"
            : "GATE_NOT_EVIDENCED",
        severity: releaseMode && gate.blocking ? "error" : "warning",
        gateId: gate.id,
        message: offline
          ? `gate "${gate.id}" is reproducible from a clean checkout and was not evidenced — run: ${gate.command}`
          : `gate "${gate.id}" needs recorded evidence — run: ${gate.command}`,
      });
    } else if (recorded.status === "pass") {
      passed += 1;
      evaluated.status = "pass";
      evaluated.detail = recorded.detail;
      evaluated.artifact = recorded.artifact;
    } else {
      failed += 1;
      evaluated.status = "fail";
      evaluated.detail = recorded.detail;
      evaluated.artifact = recorded.artifact;
      findings.push({
        code: "GATE_FAILED",
        severity: "error",
        gateId: gate.id,
        message:
          `gate "${gate.id}" failed${recorded.detail ? `: ${recorded.detail}` : ""}. ` +
          `Rollback: ${gate.rollback}`,
      });
    }

    gates.push(evaluated);
  }

  const ok = findings.every((finding) => finding.severity !== "error");
  const releaseReady = gates.every((gate) => gate.status === "pass");

  return {
    ok,
    mode,
    releaseReady,
    fingerprint: releaseReadinessFingerprint(),
    gates,
    findings,
    summary: {
      total: RELEASE_GATES.length,
      passed,
      failed,
      missing,
      blockingMissing,
    },
  };
}

/** Parse and evaluate in one step; a malformed record fails closed. */
export function evaluateReleaseEvidence(
  raw: unknown,
  options: EvaluateOptions = {},
): ReleaseReadinessReport {
  let evidence: ReleaseEvidence;
  try {
    evidence = parseReleaseEvidence(raw);
  } catch (error) {
    const mode: ReleaseMode = options.mode ?? "develop";
    const findings: ReleaseFinding[] = [
      {
        code: "EVIDENCE_INVALID",
        severity: "error",
        message: error instanceof Error ? error.message : String(error),
      },
    ];
    const gates: EvaluatedGate[] = RELEASE_GATES.map((gate) => ({
      id: gate.id as ReleaseGateId,
      title: gate.title,
      area: gate.area,
      blocking: gate.blocking,
      reproducibility: gate.reproducibility,
      status: "missing" as const,
      command: gate.command,
    }));
    return {
      ok: false,
      mode,
      releaseReady: false,
      fingerprint: releaseReadinessFingerprint(),
      gates,
      findings,
      summary: {
        total: RELEASE_GATES.length,
        passed: 0,
        failed: 0,
        missing: RELEASE_GATES.length,
        blockingMissing: RELEASE_GATES.filter((gate) => gate.blocking).length,
      },
    };
  }
  return evaluateReleaseReadiness(evidence, options);
}

// ── Formatting ───────────────────────────────────────────────────────────────

function statusMark(status: EvaluatedGateStatus): string {
  if (status === "pass") return "✓";
  if (status === "fail") return "✗";
  return "-";
}

/** Format a report for CLI / CI logs. Never echoes raw evidence values. */
export function formatReleaseReadinessReport(
  report: ReleaseReadinessReport,
): string {
  const lines: string[] = [
    `release readiness (${report.mode}): ${report.ok ? "OK" : "FAILED"}`,
    `  fingerprint ${report.fingerprint.slice(0, 16)}…`,
    `  gates ${report.summary.passed}/${report.summary.total} passing, ` +
      `${report.summary.failed} failed, ${report.summary.missing} not evidenced ` +
      `(${report.summary.blockingMissing} blocking)`,
  ];
  for (const gate of report.gates) {
    const flags = [
      gate.blocking ? "blocking" : "advisory",
      gate.reproducibility === "clean-checkout" ? "offline" : "live-evidence",
    ].join(", ");
    lines.push(
      `  ${statusMark(gate.status)} [${gate.id}] ${gate.status} — ${flags}`,
    );
    lines.push(`      $ ${gate.command}`);
    if (gate.detail) lines.push(`      · ${gate.detail}`);
    if (gate.artifact) lines.push(`      · artifact: ${gate.artifact}`);
  }
  if (report.findings.length > 0) {
    lines.push("  findings:");
    for (const finding of report.findings) {
      const mark = finding.severity === "error" ? "✗" : "!";
      const who = finding.gateId ? ` [${finding.gateId}]` : "";
      lines.push(`    ${mark}${who} ${finding.code}: ${finding.message}`);
    }
  }
  lines.push(
    report.releaseReady
      ? "  release ready: every gate in the checklist has passing evidence"
      : "  release NOT ready: the gates above are unproven — see docs/RELEASE_READINESS.md",
  );
  return lines.join("\n");
}

/**
 * The deterministic release record written by `--out`: statuses, commands and
 * findings only. No timestamps (unless the caller stamps one) and no evidence
 * text, so two runs over the same inputs are byte-identical.
 */
export function buildReleaseRecord(
  report: ReleaseReadinessReport,
  options: { recordedAt?: string } = {},
): Record<string, unknown> {
  const record: Record<string, unknown> = {
    schemaVersion: RELEASE_READINESS_SCHEMA_VERSION,
    kind: "mimir-release-readiness-record",
    mode: report.mode,
    ok: report.ok,
    releaseReady: report.releaseReady,
    fingerprint: report.fingerprint,
    summary: report.summary,
    gates: report.gates.map((gate) => ({
      id: gate.id,
      status: gate.status,
      blocking: gate.blocking,
      reproducibility: gate.reproducibility,
      command: gate.command,
      artifact: gate.artifact ?? null,
    })),
    findings: report.findings.map((finding) => ({
      code: finding.code,
      severity: finding.severity,
      gateId: finding.gateId ?? null,
    })),
  };
  if (options.recordedAt) record.recordedAt = options.recordedAt;
  return record;
}

/** Serialize a release record deterministically (sorted keys, trailing newline). */
export function serializeReleaseRecord(
  record: Record<string, unknown>,
): string {
  return `${canonicalJson(record)}\n`;
}
