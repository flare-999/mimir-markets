# Contract toolchains

The Soroban contracts in `contracts-soroban/` are tested in CI against three Rust
toolchains. Three files describe them, and `npm run check:toolchains` fails when
they disagree.

| File | What it sets | Why |
| --- | --- | --- |
| `rust-toolchain.toml` (repo root) | The **release** toolchain, an exact `X.Y.Z`, plus the `wasm32v1-none` target | soroban-sdk writes the rustc version into each wasm's contract metadata, so the wasm hash `npm run verify:deployment` compares against the chain only matches when the build used the same compiler. A floating `stable` would break that comparison the day a new Rust ships. |
| `contracts-soroban/Cargo.toml` | The **MSRV** , as `rust-version` under `[workspace.package]`; each member inherits it with `rust-version.workspace = true` | An older compiler then stops with "requires rustc X" instead of an obscure error deep in a dependency. It is soroban-sdk's own `rust-version`, currently 1.91. |
| `.github/workflows/ci.yml` | The `contracts` job matrix: `msrv`, `release`, `stable` | Runs `cargo test --release --locked` and the wasm build under each toolchain. |

## What each CI entry means

- **msrv**: the contracts still build and pass on the oldest supported rustc. A failure here means a change used a newer language or library feature. Either avoid it, or raise the MSRV on purpose (see below).
- **release**: the toolchain deployed wasm is built with. The job writes each wasm's sha256 to the run summary and uploads the files as the `contract-wasm-release` artifact (kept 14 days). A reviewer can compare those hashes against `verify:deployment` output without installing Rust. It also regenerates the TypeScript bindings from the built wasm and fails when `sdk/contracts/*` is out of date (see below).
- **stable**: an early warning for the next Rust release. It doesn't change what gets deployed. A failure means the next release-pin bump needs work first; it is not a reason to bump the pin.

The matrix uses `fail-fast: false`, so one failing entry never hides the others. We suggest maintainers make `verify`, `contracts (msrv)` and `contracts (release)` required checks. `contracts (stable)` can break without anyone touching this repo, when a new Rust ships, so it stays advisory.

## Running it locally

No secrets or network access to Stellar are needed.

```bash
npm run check:toolchains     # the three files agree (Node only, no Rust needed)
npm run test:contracts      # uses rust-toolchain.toml; rustup installs it on first use
cargo +1.91.0 test --manifest-path contracts-soroban/Cargo.toml --release --locked   # the msrv entry
cargo +stable test --manifest-path contracts-soroban/Cargo.toml --release --locked   # the stable entry
```

Inside this repo, rustup picks `rust-toolchain.toml` over your default toolchain. `cargo +<toolchain>` or `RUSTP_TOOLCHAIN=<toolchain>` overrides it for one command; that is also how CI runs the other matrix entries.

## Regenerating contract bindings

`sdk/contracts/mimir-market` and `sdk/contracts/mimir-squad` are generated TypeScript bindings consumed by `lib/contract.ts`. When a contract entry point changes, the bindings must be regenerated in the same PR. The `contracts (release)` job enforces this.

Against the live testnet deployment (requires the deployed contract ids in your env):

```bash
npm run stellar:bindings
```

Against local wasm builds (no network access or secrets, this is what CI runs):

```bash
# Build the wasm with the release toolchain first.
cargo build --release --locked --target wasm32v1-none --manifest-path contracts-soroban/Cargo.toml
npx tsx scripts/check-binding-drift.ts --wasm-dir target/wasm32v1-none/release --write
git diff --exit-code sdk/contracts
```

The generator is `stellar contract bindings`, pinned to a specific `stellar-cli` release in the contracts job. To check without writing, drop `--write; the script exits non-zero and lists the files that differ.

## Dev container

Contributors who don't want to install Node, Rust and the Stellar CLI by themselves can open this repo in a Codespace or the VS Code Dev Containers extension. `.devcontainer/` pins every tool to the same versions the checks above use:

- Node from `.nvmrc`.
- Rust from `rust-toolchain.toml`, with the `wasm32v1-none` target already installed.
- A pinned `stellar-cli` release for the bindings script.

After the container is created it runs `npm ci` and fetches no secrets. The same
commands as above work inside it:

```bash
npm run test:node
npm run test:contracts
```

The container does not run workers; that remains outside its scope.

`Binding drift` is checked separately by `scripts/check-binding-drift.ts`, which regenerates `sdk/contracts/*` from the release wasm and compares the result against the committed files. It needs no network access or secrets.

## Changing a version

**Bumping the release toolchain* changes the wasm bytes and therefore the hash of every future deploy:

1. Change `channel` in `rust-toolchain.toml` and the `release` entry in `ci.yml` together. `check:toolchains` fails if you change only one.
2. Make sure `contracts (stable)` is green on that version first.
3. Contracts that are already deployed keep their old hash. After the bump, `verify:deployment` on the existing deployment reports a hash mismatch until the contracts are redeployed. To check an existing deployment, build at the commit and toolchain it was deployed from.
4. Mention the bump in the PR and in the release notes for the next deploy.

**Artifact provenance pins** (`deploy/contract-artifacts.manifest.json`, checked by `npm run verify:artifacts`) describe release-toolchain output. Write them with `npm run verify:artifacts -- --write-pins` after a build that used `rust-toolchain.toml`, which is the default inside this repo. A pin written from any other compiler can never match CI. In CI, only the `release` entry runs `verify:artifacts -- --require-built`. The msrv and stable builds have different hashes by design, so they skip it. A release-toolchain bump changes every pinned digest, so re-pin in the same PR.

**Raising the MSRV** changes `rust-version` in `contracts-soroban/Cargo.toml` and the `msrv` entry in `ci.yml` together. It is normally needed only when soroban-sdk raises its own `rust-version`. The release toolchain can never be older than the MSRV; the check refuses that.

**Rolling back** is reverting the commit. The toolchain files hold no state, and nothing is deployed from CI. The only lasting effect of a release bump is on wasm built and deployed while it was in place (step 3 above).

## How the check works

`scripts/lib/contract-toolchains.ts` holds pure functions over the file contents. `scripts/check-contract-toolchains.ts` feeds them the real files. `tests/node/contract-toolchains.test.ts` feeds them fixtures, one per rule, and ends by checking the repo's own files. Each problem it reports names the file to change.

`Binding drift` is checked separately by `scripts/check-binding-drift.ts`, which regenerates `sdk/contracts/*` from the release wasm and compares the result against the committed files. It needs no network access or secrets.

## Resource budget regression tests

Soroban caps how much work a single transaction may do (CPU instructions,
memory, and the number of ledger entries it reads and writes). Settlement was
split into O(1) `resolve_claim` plus per-challenger `claim_challenger_payout` for that
reason, but nothing measured the costs. Each crate now has a `test_budgets.rs`
that drives the heavy entry points in their worst case and asserts the Soroban
test environment's reported cost stays under a ceiling.

### What is measured

Each test runs the call inside a fresh `Env and then reads the budget from the
environment's diagnostics after the invocation. The counters are:

| Counter | Source | What it catches |
| --- | --- | --- |
| CPU instructions | `env.cost_estimator().get_cpu_instructions()` | Algorithmic work: loops over challengers, sorting, serialisation. |
| Memory bytes | `env.cost_estimator().get_memory_bytes()` | Allocations for vectors and intermediate values. |
| Ledger read entries | `env.cost_estimator().get_ledger_read_entries()` | How many storage keys the call touches. Capped per transaction. |
| Ledger write entries | `env.cost_estimator().get_ledger_write_entries()` | How many storage keys the call mutates. Capped per transaction. |

The heavy entry points covered are:

- `resolve_claim` at its worst case (all challengers paying out).
- `challenge_claim` with `total_challengers` at `MAX_CHALLENGERS`.
- `get_claims_batch(50)` with a full batch.
- squad `claim` at its worst case.

### Updating a ceiling

The ceilings live as constants at the top of each crate's `test_budgets.rs`,
named `MAX_CPU_INSTRUCTIONS`, `MAX_MEMORY_BYTES`, `MAX_READ_ENTRIES` and
`MAX_WRITE_ENTRIES`. They are set with headroom above the current measured
value so normal drift does not fail CI, but a change that materially adds work does.

When a budget test fails:

1. Run it locally with `npm run test:contracts -- test_budgets`. The failure
message prints the measured value and the ceiling.
2. Decide whether the increase is justified. If it is not, fix the contract.
3. If it is, raise the constant to the new measured value plus the same
   percentage headroom the other ceilings use, and mention the new number and
   why in the PR description.
4. Never raise a ceiling to make a test pass without that justification; the
tests exist to stop exactly that.

The ceilings are not the chain's hard limits. They are tighter, so a change
that would still fit on chain but eats the headroom still fails CI and gets
reviewed. The chain's actual limits are set by the network configuration and can
shift between protocol versions.