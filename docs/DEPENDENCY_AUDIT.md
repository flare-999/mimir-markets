Dependency vulnerability triage
Mimir triages production npm advisories so funded features ship with a
predictable safety bar. The checker reads npm audit --json and fails closed
on high/critical findings, unknown severities, and unreadable output.

What this is (and is not)
Input	npm audit --omit=dev --json (lockfile + public advisory database)
Checker	lib/ops/dependency-audit.ts via npm run audit:deps
Secrets	None. No DATABASE_URL, Stellar seeds, LLM keys, or deploy tokens
Money / chain	Untouched. The gate never skips settlement, escrow, or deploy controls
DevDependencies	Out of scope for the blocking threshold (production tree only)
Live npm audit talks to the public npm registry. The checker itself is
offline and is what CI, fixtures, and maintainers use to decide pass/fail.

Local reproduction (clean checkout)
Bash

npm ci
npm audit --omit=dev --json > npm-audit.json
npm run audit:deps -- --json npm-audit.json --out npm-audit-report.md
Fixture-only (no registry, no npm audit):

Bash

npm run audit:deps -- --json tests/fixtures/dependency-audit/clean.json
node --import tsx --test tests/node/dependency-audit.test.ts
Exit 0 is a clean production tree (or only low/moderate advisories). Exit 1
is actionable: blocking advisories, malformed JSON, an npm error object, or a
missing report. There is no skip flag.

Workflows
Workflow	When	What
.github/workflows/ci.yml	every pull request and push to main	production audit + triage; uploads evidence
.github/workflows/dependency-audit.yml	Monday 04:17 UTC, and workflow_dispatch	the same check, so newly published advisories are caught without a PR
Both jobs:

Check out the tree with persist-credentials: false.
Install from the lockfile (npm ci) with Node 22.
Run npm audit --omit=dev --json (no --audit-level; the checker decides).
Run scripts/check-npm-audit.ts, which always writes npm-audit-report.md.
Upload npm-audit.json and npm-audit-report.md (if: always(), 14 days).
Permissions are contents: read. No environment, no production secrets, no
NPM_TOKEN.

Failure / rollback / artifacts / environment
Situation	Behavior
High or critical production advisory	Job fails. Markdown names the package, severity, direct/transitive, and whether a fix is recorded
Unknown / missing severity	Job fails (fail-closed — do not guess it is low)
Empty, malformed, or npm error JSON	Job fails. Do not treat an incomplete scan as clean
Metadata claims high/critical but the body lists none	Job fails (inconsistent report)
Low / moderate only	Pass. Still listed in the report for maintainer awareness
Artifact upload	Always attempted. Missing files fail the upload step
Secrets in advisory URLs	Redacted (user:pass@, token= query params). Filesystem nodes paths are never copied into the report
Rollback of a bad upgrade	Revert the dependency change; re-run npm run audit:deps. Do not disable the gate
Rollback of this workflow	Revert the workflow/script commit. Markets, settlement, and deploy credentials are unaffected
Environment	Ubuntu, Node 22, lockfile install. No .env, no wallet seeds
Do not add SKIP_AUDIT, --force on main, or a secrets-bearing allowlist.
A failed audit blocks merge and release the same way typecheck does; it does
not bypass money or deployment controls.

Maintainer workflow
Read the uploaded npm-audit-report.md (or the job log).
Upgrade the affected production package to a fixed release in range.
Re-run npm ci and npm run audit:deps.
Keep unrelated major upgrades and lockfile churn out of the same PR
(those are out of scope for this gate).
Contributor-facing commands live in the README scripts table. This document
is the operational contract: failure, rollback, artifacts, secrets, environment.

Tests
Bash

node --import tsx --test tests/node/dependency-audit.test.ts
Coverage includes the committed fixtures: clean pass, low/moderate pass, high/
critical fail, unknown severity, malformed JSON, npm error objects, missing
vulnerabilities, unsupported report version, inconsistent metadata, privacy
redaction, severity-rank sorting, and CLI --out writing.