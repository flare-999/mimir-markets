Release readiness checklist
Mimir moves USDC on Stellar Testnet, so "it builds on my machine" is not a
release argument. This document is the checklist a maintainer runs before a
funded release; lib/ops/release-readiness.ts is the same checklist as data,
and scripts/verify-release-readiness.ts enforces it. The doc and the registry
cannot drift: the CLI fails when a gate id or command stops appearing here.

CI path filters are documented separately in
[docs/CI_PATH_SCOPES.md](./CI_PATH_SCOPES.md).

How to run it
Bash

# From a clean checkout, no production secrets, no .env, no DATABASE_URL:
npm ci
npm run verify:release-readiness                 # self-check + every offline gate

npm run verify:release-readiness -- --list       # print every gate in full
npm run verify:release-readiness -- --json       # machine-readable report

# A funded release also records the evidence for the gates that need a live
# deployment, then runs the checklist in release mode:
npm run verify:release-readiness -- --evidence evidence.json --mode=release
npm run verify:release-readiness -- --out release-record.json
Two modes, and the difference is the whole point:

Mode	Meaning
develop (default)	The CLI verifies what it can run itself: checklist coherence, artifact provenance, the cache-backup fixture, the saved-ledger replay and the SBOM. Anything not run in this invocation - the remaining offline gates (each of which CI runs as its own step) and everything that needs a live deployment - is reported as not evidenced (a warning), never as passing. Exit code 0 means "the reproducible part of the release is green".
release	Every gate must have recorded evidence and pass. A gate with no evidence is an error, so a release cannot be declared ready by omitting the gates that need a deployment.
CI runs the develop mode on every pull request (the verify job in
.github/workflows/ci.yml), so a release never discovers these checks late.

If a new top-level folder or file needs its own CI tier, follow the checklist
in [docs/CI_PATH_SCOPES.md](./CI_PATH_SCOPES.md) before opening the pull request.

The checklist
22 gates: 12 reproducible from a clean
checkout, 10 that need a live deployment or a human
signature. Registry fingerprint 5bb50d7ce3e0857b8bf4e091251b6a471fd6603a9ebb27aef2ab4330092442fe — pinned by
tests/node/release-readiness.test.ts, so a gate added, removed or re-scoped
shows up as a fingerprint change in the same pull request.

Gate	What it proves	Area	Blocking	Runs from	Command
typecheck	TypeScript compiles across the app, workers, scripts and tests	build	blocking	clean checkout	npm run typecheck
forbidden-terms	Forbidden-terms guardrail passes	security	blocking	clean checkout	npm run check:terms
contract-tests	Soroban contract test suite passes	contracts	blocking	clean checkout	npm run test:contracts
contract-build	Release Wasm builds for both contracts	artifacts	blocking	clean checkout	cargo build --manifest-path contracts-soroban/Cargo.toml --release --target wasm32v1-none
node-tests	Node test suite passes	build	blocking	clean checkout	npm run test:smoke
app-build	Production Next.js build succeeds	build	blocking	clean checkout	npm run build
browser-smoke	Secret-free browser smoke passes	deployment	blocking	clean checkout	npm run smoke:browser
artifact-provenance	Contract Wasm digests match the committed pins	artifacts	blocking	clean checkout	npm run verify:artifacts -- --mode=release --require-built
release-sbom	Release SBOM generates from the committed lockfile	artifacts	blocking	clean checkout	npm run sbom:release
cache-backup-verify	Offline cache-backup verification passes	rollback	blocking	clean checkout	npm run verify:cache-backup -- tests/fixtures/cache-backup/valid.json
ledger-fixture-replay	Saved ledger fixture replays to the reviewed fingerprint	contracts	blocking	clean checkout	npm run check:ledger-fixture
release-readiness-checklist	This checklist is coherent and documented	docs	blocking	clean checkout	npm run verify:release-readiness
deployment-verification	Deployed contracts match configuration and the local build	deployment	blocking	recorded evidence	npm run verify:deployment
onchain-smoke	On-chain smoke (resolve + squad) passes on Testnet	deployment	blocking	recorded evidence	npm run smoke:onchain --resolve --squad
x402-payment-smoke	x402 payment scheme smoke passes	security	blocking	recorded evidence	npm run smoke:x402
analytics-gates	Analytics gates pass on a real traffic export	observability	blocking	recorded evidence	npm run verify:analytics -- <export.json>
contract-audit	Independent audit of both Soroban contracts is attached	security	blocking	recorded evidence	Attach the independent audit of contracts-soroban/mimir-market and contracts-soroban/mimir-squad
legal-eligibility-review	Legal, custody, sanctions/eligibility and mainnet review complete	security	blocking	recorded evidence	Record written product, legal and eligibility approval for the funded surfaces
redundant-providers	Redundant Soroban RPC and Horizon providers are configured	deployment	blocking	recorded evidence	Configure and monitor a second RPC and Horizon provider in the deploy env
funded-feature-flags	Funded features remain off until their evidence is attached	security	blocking	recorded evidence	Confirm the funded BYOA / copy-trading / basket flags are 0 and the pause controls are 1 in the deploy env
rollback-rehearsal	Rollback runbook has been rehearsed	rollback	blocking	recorded evidence	Rehearse the cache restore dry-run and the previous-pinned-Wasm redeploy
load-baseline	Load baselines recorded for verification and rate limiting	observability	advisory	recorded evidence	npm run load:x402 && npm run load:rate-limit
Failure, rollback and artifacts
Every gate states what happens when it fails, how to roll back, and what it
leaves behind. Nothing here silently bypasses a money or deployment control: a
gate that cannot be run is missing evidence, not a pass.

Gate	On failure	Rollback	Leaves behind
typecheck	tsc --noEmit reports a type error and the release stops. A tree that does not compile can ship a route that throws at runtime — including a money path — so this is never downgraded to a warning.	Revert the offending commit and re-run npm run typecheck. There is no runtime toggle: a type error is a build-time stop, and loosening tsconfig strictness to hide one is not a rollback.	tsc diagnostics on stdout; nothing is written (--noEmit).
forbidden-terms	A tracked file mentions a pre-Stellar chain name, a bespoke payment header, or a secret-shaped literal. The check fails the build with the file and line, before anything is deployed.	Remove the offending token and re-run. Adding a file to SKIP_FILES is allowed only for a file that deliberately holds a synthetic secret sample (the existing tests/node/x402-fixtures.ts precedent), never to silence a real leak.	A per-file, per-line hit list on stderr; nothing is uploaded.
contract-tests	A Rust test fails: escrow conservation, payout maths, fee policy, challenger pull-payouts or a state-machine guard regressed. The release stops; the failing test names the invariant.	Revert the contract change and re-run. A contract rollback on chain is a redeploy of the previously pinned Wasm (see rollback-rehearsal), never an in-place edit of live storage.	cargo test output; no on-chain transaction is submitted.
contract-build	The release build fails, so there is no artifact to pin or deploy. Nothing downstream may proceed: provenance, deployment verification and on-chain smoke all consume these bytes.	Fix the build or revert the change, then rebuild and re-pin. Never deploy a Wasm whose digest is not the one the manifest pins.	contracts-soroban/target/wasm32v1-none/release/mimir_market.wasm and mimir_squad.wasm (gitignored build output).
node-tests	A node test fails. The runner prints the failing file and assertion; treat it as a release stop, not a flake to re-run.	Revert the change that broke it, or fix the code the test pins. Never delete or skip a test to go green.	TAP output on stdout; no artifact is written.
app-build	next build fails, so there is no deployable bundle. A build that only succeeds with a developer's local .env is a failure of this gate, not a pass.	Revert the change and rebuild, or redeploy the previous production build from the host's deployment history.	.next/ build output (gitignored).
browser-smoke	The Playwright suite fails against a build served with a strict secret-free env allowlist. Health must be 503 critical with db.unconfigured, the arena feed empty, and money paths gated behind a connect control.	Revert the page or env-read that broke the unconfigured state, then re-run. The runner tears down cleanly, so the same command always reproduces what CI ran.	playwright-report/ and test-results/ (uploaded for 7 days by CI on failure only).
artifact-provenance	A Wasm is missing, unpinned, or its sha256 differs from deploy/contract-artifacts.manifest.json. Release mode fails closed: an unpinned artifact is an error, not a warning.	Refuse to deploy or roll back to the mismatched build. Re-pin only after an intentional rebuild has been reviewed, with npm run verify:artifacts -- --write-pins.	A digest list per artifact id; no network calls, no RPC.
release-sbom	The lockfile is missing, corrupt, an unsupported lockfileVersion, or yields zero components. Generation fails closed and nothing is uploaded — an empty SBOM is never published.	Re-run npm install to refresh package-lock.json, or re-run the release-sbom workflow (--clobber) / delete the bad release asset.	sbom/mimir.cdx.json locally; mimir-<tag>.cdx.json attached to the GitHub release by .github/workflows/release-sbom.yml.
cache-backup-verify	The committed archive fails schema, checksum or privacy verification. Fail-closed findings: BACKUP_INVALID, BACKUP_KIND_MISMATCH, BACKUP_SCHEMA_UNSUPPORTED, BACKUP_MISSING_TABLE, BACKUP_UNKNOWN_TABLE, BACKUP_EMPTY, BACKUP_CHECKSUM_MISMATCH, BACKUP_PRIVATE_CONTENT_LEAK.	Do not restore the archive. Regenerate it from a healthy database, or re-warm the read index from chain — the chain stays the source of truth and is never written by a restore.	A pass/fail verdict plus the archive checksum; no database or network access.
ledger-fixture-replay	Replay is refused: partial capture, orphan events, conflicting ledger positions, unsafe (non-string) money values, or a fingerprint that differs from the reviewed fixture.	Roll the projection and the fixture back together, re-run the release checks, and redeploy the sync worker. Never copy fixture rows into production.	One JSON reconciliation artifact on stdout (ledger bounds, fingerprint, resume cursor, deterministic rows).
release-readiness-checklist	A gate is structurally invalid, its npm script is missing from package.json, a declared path is absent, or docs/RELEASE_READINESS.md no longer describes every gate id and command. The checklist fails instead of drifting.	Restore the missing script, path or doc section, or update the doc in the same pull request that changes the gate. Never silence the check to ship.	The printed checklist, and — with --out — a deterministic JSON release record (no timestamps unless --stamp).
deployment-verification	An on-chain value (owner, oracle, USDC SAC, fee policy, WASM hash) disagrees with the configured environment, or the RPC reports an unhealthy or wrong-passphrase network. Read-only: nothing is submitted.	Stop the rollout. Redeploy from the previously pinned Wasm and restore the env, then re-run verification. A wrong fee policy or oracle address is a deployment rollback, not a runtime flag.	A verification log with the compared values; retain the contract ids, the deployed WASM hash, ledger sequences and transaction hashes.
onchain-smoke	A create → challenge → resolve → refund / pull-payout cycle fails against the live deployment. Funded flows are blocked until the smoke passes.	Pause settlement (MIMIR_PAUSE_ORACLE_SETTLEMENT=1), redeploy the previous pinned Wasm, and re-run the smoke before resuming.	Transaction hashes and resolve / refund / pull-payout evidence; retain them with the release record.
x402-payment-smoke	A paid endpoint refuses a valid proof, or accepts one it cannot verify off Horizon. Unverified payments are never recorded as revenue, so the failure is a refusal, not a silent sale.	Pause selling (MIMIR_PAUSE_X402_SELLING=1) — reads and settlement keep working — then restore the provider endpoint and re-run the smoke.	Payment hashes and the verification reasons observed.
analytics-gates	The export cannot show measurable create/stake funnels or 99% required-field completeness. The launch gate stays open; it is not closed by synthetic data.	Not a runtime rollback: re-collect a longer, non-internal export and re-run. Fix instrumentation before claiming the funnel.	A gate verdict per funnel metric over the supplied export file.
contract-audit	No independent audit exists for the Soroban contracts. The prior EVM review does not carry over, so the gate stays open and funded features stay off.	Not reversible by configuration: if an audit finding invalidates a control, revert to the last audited build and keep the money flags off.	The audit report and the maintainers' written disposition of each finding.
legal-eligibility-review	Approval is missing, so the corresponding money-moving feature flag stays off. This gate is closed by named approvers, never by code.	Keep the feature flag off. Rolling back an approval means turning the funded surface back off, which is the shipped default.	Signed approvals and the eligibility policy they reference.
redundant-providers	Only the rate-limited public endpoints are configured, so a provider outage makes chain reads — and therefore money paths — unavailable with no fallback.	Restore the primary provider; reads resume without a deploy. A provider failover is a configuration change, never a code change.	Provider configuration plus the monitoring evidence that failover was exercised.
funded-feature-flags	A funded feature is enabled without its audit, legal and eligibility evidence. That is a release-blocking misconfiguration, not a configuration choice.	Set the flag to 0 (and the matching pause to 1) in the deploy env — an env change, no redeploy — and confirm the funded path refuses.	The recorded flag posture for the release record.
rollback-rehearsal	Nobody has executed the rollback path for this release, so an incident would be handled by improvisation while funds are exposed.	This gate is the rollback: restoring a verified archive, re-warming the index from chain, or redeploying the previously pinned Wasm. Rehearse it before release, not during the incident.	A dated rehearsal note naming who ran it and what was restored.
load-baseline	No baseline exists, so a regression in verification latency or rate-limit behaviour would be invisible until it affects paid traffic.	Not a rollback gate: re-run the load scripts after a performance fix and compare against the recorded baseline.	Throughput and latency numbers from the two offline load scripts.
Secrets and environment
A clean-checkout gate must declare secrets: "none" and read no environment
variable — that is what makes it reproducible from a fresh clone. The registry
validator refuses a gate that claims both. Gates that do need a deployment only
ever need public configuration (contract ids, RPC/Horizon endpoints, G…
addresses) plus, for the on-chain smoke, a Testnet signing seed held in the
worker environment. No gate reads a production secret, and none is required to
run the checklist.

Gate	Secrets	Environment it reads	Environment behavior
typecheck	none	(none)	Needs only the devDependencies installed by npm ci. No .env file, no DATABASE_URL, no Stellar credentials.
forbidden-terms	none	(none)	Runs offline over git ls-files; no network, no credentials.
contract-tests	none	(none)	Needs the Rust toolchain with the wasm32v1-none target. No RPC endpoint, no seeds, no DATABASE_URL.
contract-build	none	(none)	Rust toolchain with the wasm32v1-none target; fully offline once crates are vendored by cargo.
node-tests	none	(none)	npm ci only. Tests that need a database or RPC skip themselves with an explicit reason rather than pretending to pass.
app-build	none	(none)	No secrets and no DATABASE_URL are required: the app must build in its unconfigured, fail-closed state. The browser smoke job proves exactly that.
browser-smoke	none	(none)	The harness moves every .env* file aside and builds with only buildSmokeEnv() keys. A new secret-shaped variable must NOT be added to that allowlist.
artifact-provenance	none	(none)	Reads the manifest and the built Wasm from disk. Offline and reproducible from a clean checkout after the contract build.
release-sbom	none	(none)	Reads package-lock.json at the release tag only. No registry calls, no deployment credentials.
cache-backup-verify	none	(none)	No DATABASE_URL, no Soroban RPC, no seeds: a pure function of the archive bytes, reproducible anywhere.
ledger-fixture-replay	none	(none)	Offline and read-only: no Postgres write, no live cursor, no RPC, no .env.
release-readiness-checklist	none	(none)	Reads only tracked repo files. Never reads .env, never requires production credentials.
deployment-verification	operator-supplied	NEXT_PUBLIC_STELLAR_MARKET_CONTRACT_ID, NEXT_PUBLIC_STELLAR_SQUAD_CONTRACT_ID, NEXT_PUBLIC_STELLAR_USDC_SAC_ID, NEXT_PUBLIC_STELLAR_RPC_URL, NEXT_PUBLIC_STELLAR_HORIZON_URL, NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE, SELLER_ADDRESS, ORACLE_ADDRESS	Needs the deployment env (contract ids, RPC/Horizon endpoints, public G… addresses). Never needs a seed: the verifier only reads.
onchain-smoke	operator-supplied	NEXT_PUBLIC_STELLAR_MARKET_CONTRACT_ID, NEXT_PUBLIC_STELLAR_SQUAD_CONTRACT_ID, NEXT_PUBLIC_STELLAR_USDC_SAC_ID, NEXT_PUBLIC_STELLAR_RPC_URL, NEXT_PUBLIC_STELLAR_HORIZON_URL, STELLAR_ORACLE_SECRET	Needs the oracle's signing seed and the deployed contract ids. Run against Testnet only; never against mainnet funds.
x402-payment-smoke	operator-supplied	NEXT_PUBLIC_STELLAR_HORIZON_URL, X402_NETWORK, SELLER_ADDRESS	Needs the seller address and a funded buyer on Testnet. No facilitator and no HTTP third party is involved.
analytics-gates	none	(none)	Needs a real (non-internal) analytics export as a file. No production API key is read by the checker itself.
contract-audit	none	(none)	Human review. The audit must cover Soroban-specific surface: authorization sites, storage TTL/archival, ledger-entry footprint under adversarial input, contract-account callers.
legal-eligibility-review	none	(none)	Human review; no technical environment required.
redundant-providers	operator-supplied	NEXT_PUBLIC_STELLAR_RPC_URL, NEXT_PUBLIC_STELLAR_HORIZON_URL	Deployment env only. Provider URLs are public endpoints, not credentials.
funded-feature-flags	none	MIMIR_FEATURE_COPY_TRADING, MIMIR_PAUSE_COPY_EXECUTION	Deployment env only; the flag names are recorded, never their secret-shaped neighbours.
rollback-rehearsal	none	(none)	Staging or Testnet. The restore dry-run needs a DATABASE_URL for a non-production database only.
load-baseline	none	(none)	Offline: fixture-driven, no network and no production credentials.
Evidence recorded for the live gates is privacy-safe by construction:
parseReleaseEvidence accepts only pass or fail (a waived, skipped,
n/a or pending status is refused, so no gate can be bypassed), and any
recorded detail or artifact string that looks like a credential — a
Stellar seed, an sk-/rk- key, a gh*_ token, a phc_ key, an AKIA
key, a PEM private key, or a URL with embedded credentials — is refused rather
than written into a record that gets attached to a release.

What each gate protects
Gate	Money or deployment control it protects
typecheck	Every funded route and worker: a type error in a stake, payout or settlement path is caught before deploy.
forbidden-terms	Chain and payment-scheme identity: the app must not drift back to a non-Stellar rail or a hand-rolled payment header.
contract-tests	The code that custodies and moves USDC: escrow, settlement, fees and payouts.
contract-build	Artifact provenance: the shipped Wasm must be the one that was reviewed and pinned.
node-tests	Money maths, fail-closed API behavior, rate limits, privacy scrubbing and every other invariant the suite pins.
app-build	Deployment integrity: what CI builds is what ships, and it builds without production credentials.
browser-smoke	The fail-closed posture of the shipped app: no page may require a live credential or a live deployment to render safely.
artifact-provenance	The exact bytes that hold user funds: an unreviewed or tampered Wasm must never reach a funded deployment.
release-sbom	Dependency transparency for operators: every shipped tag must be inventariable.
cache-backup-verify	The restore path itself: a backup that cannot be verified offline cannot be trusted near money-adjacent state.
ledger-fixture-replay	Chain-first accounting: the read index must remain a pure fold of chain events, provable without a database.
release-readiness-checklist	The release process itself: the checklist a maintainer follows and the checklist CI enforces cannot diverge.
deployment-verification	The live money configuration: fee policy, oracle authority and the USDC asset the contracts actually move.
onchain-smoke	The full settlement lifecycle end to end, including the pull-based challenger payout path.
x402-payment-smoke	Paid revenue: a proof must be read back off the ledger or the request is refused.
analytics-gates	Product claims about usage: nothing funded ships on the strength of an unmeasured funnel.
contract-audit	Custody of user funds in the two contracts that hold escrow and pool balances.
legal-eligibility-review	Regulatory and custody posture for anything that holds or moves user funds.
redundant-providers	Availability of chain reads, which every stake, settlement and verification path depends on.
funded-feature-flags	Funded-feature blast radius: off by default is the shipped posture until evidence exists.
rollback-rehearsal	Recovery time: the read index is disposable and rebuildable from chain, but only if that has been practised.
load-baseline	Paid-endpoint capacity: a verification path that slows down under load is a revenue and availability risk.
Recording evidence
Evidence is a small JSON file. Every gate that was run appears with pass or
fail; a gate that was not run is simply absent, and the checklist reports it
as missing.

JSON

{
  "schemaVersion": 1,
  "kind": "mimir-release-readiness",
  "results": {
    "deployment-verification": {
      "status": "pass",
      "detail": "on-chain owner, oracle, USDC SAC, fee policy and WASM hash all match",
      "artifact": "verify-deployment log retained with the release record"
    },
    "contract-audit": {
      "status": "pass",
      "detail": "independent Soroban audit attached, findings dispositioned"
    }
  }
}
Committed fixtures cover the interesting shapes:
tests/fixtures/release-readiness/ready.json (every gate passes),
offline-only.json (nothing recorded for the live gates — ready in develop
mode, refused in release mode), failed-gate.json, unknown-gate.json,
waived-gate.json, secret-shaped.json and empty-results.json.

Failure, rollback and operational impact of the checklist itself
Failure. The CLI exits non-zero and prints the failing gate, the reason
and the gate's rollback note. It never prints evidence text or environment
values, so its output is safe to paste into a pull request or a public log.
Rollback. The checklist is read-only: it deploys nothing, writes nothing
to the chain or the database, and touches no live configuration. Rolling the
checklist back means reverting the commit; rolling a release back means
redeploying the previously pinned Wasm, restoring a verified read-index
archive, or re-warming the index from chain — see
docs/AGENT_INCIDENT_RUNBOOK.md and the rollback-rehearsal gate.
Artifacts. With --out, a deterministic JSON release record (statuses,
commands and findings only; no timestamps unless --stamp). Two runs over
the same inputs are byte-identical, so the record can be diffed.
Secrets. None. The checklist reads tracked repo files only.
Environment. No .env, no DATABASE_URL, no seeds, no network.
Tests
Bash

node --import tsx --test tests/node/release-readiness.test.ts
Coverage: positive (a fully evidenced release is ready), negative (unknown gate
ids, non-pass/fail statuses, waiver keys and empty records are refused),
failure (a failed gate and a secret-shaped detail both fail closed) and
regression (the fingerprint, the documented gate list, the npm scripts, the
declared paths and the CI wiring).

The CI tier matrix that decides which of these gates run for a given change is
documented in [docs/CI_PATH_SCOPES.md](./CI_PATH_SCOPES.md), including the
checklist for adding a new path to the scope tables.

Gate ids
typecheck, forbidden-terms, contract-tests, contract-build, node-tests, app-build, browser-smoke, artifact-provenance, release-sbom, cache-backup-verify, ledger-fixture-replay, release-readiness-checklist, deployment-verification, onchain-smoke, x402-payment-smoke, analytics-gates, contract-audit, legal-eligibility-review, redundant-providers, funded-feature-flags, rollback-rehearsal, load-baseline