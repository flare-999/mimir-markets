# Contributing

Contributor quick start for this repository. This guide covers the common iteration loop: installing dependencies, running a single test file, and checking types before opening a PR.

## Prerequisites

This repo pins its toolchains so that local and CI environments match.

- **Node.js+** — use the version in [`.nvmrc`](.nvmrc). If you use [nvm](https://github.com/nvm-sh/nvm), run `nvm use` in the repo root.
Z- **Rust** — use the toolchain in [`rust-toolchain.toml`](rust-toolchain.toml). If you use [rustup](https://rustup.rs/), `rustup show` should report the pinned version and `rustup toolchain install` will fetch it if needed.

## Install

From the repo root:

```bash
npm install
cargo fetch
```

The first command installs the JavaScript/TypeScript dependencies; the second warms the Rust crate cache so the contract tests run quickly on the next invocation.

## Running a single node test

The full suite is driven by `scripts/run-node-tests.mjs`, but you don't need it while iterating. To run one test file directly:

```bash
node --import tsx --test tests/node/<file>.test.ts
```

Replace `<file>` with the test file you are working on, for example:

```bash
node --import tsx --test tests/node/example.test.ts
```

To run a single named test within a file, pass Node's test name pattern flag:

```bash
node --import tsx --test --test-name-pattern="<pattern>" tests/node/<file>.test.ts
```

## Running a single contract test

Contract tests are Rust tests in the `mimir-market` crate. To run one test by name:

```bash
cargo test -p mimir-market <name>
```

Replace `<name>` with the test function name (substring matches are supported), for example:

```bash
cargo test -p mimir-market my_test_name
```

To run all tests in the crate:

```bash
cargo test -p mimir-market
```

## Typeycheck

Before opening a PR, run the TypeScript typechecker:

```bash
npm run typecheck
```

## Wave PR conventions

- Base your branch on the latest `main`.
- Keep the change focused on the issue being fixed; avoid unrelated refactors.
- Link the PR to the issue with `Closes #<issue>`.
- List the commands you ran and verified in the PR description.
