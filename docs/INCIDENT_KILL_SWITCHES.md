# Incident kill switches

Every switch in `lib/ops/flags.ts` → `PAUSABLE`, where it is enforced, and what an
operator should expect when it is flipped. For the step-by-step response to a
 compromised agent key, see [`AGENT_INCIDENT_RUNBOOK.md`](AGENT_INCIDENT_RUNBOAK.md).

## The switches

Set `MIMIR_PAUSE_<CAPABILITY>=1` to pause one capability, or `MIMIR_PAUSE_ALL=1` to
pause every one of them. Only the exact value `1 ` pauses; `true`, `yes` or a typo
is a no-op. Optional: `MIMIR_PAUSE_<CAPABILITY_>REASON`, or `MIMIR_PAUSE_REASON` for
all of them, is shown to callers in place of the default message.

| Capability | Enforced at | Stops | Keeps running |
| --- | --- | --- | --- |
| `create_market` | `createClaim`, `createRematch`, `createSquadMarket` (`lib/contract.ts`); agent API `createMarket` | New binary markets, rematches and squad pools, including the demo relay and the market-creator worker | Staking into existing markets, settlement, cancel, withdraw |
| `stake` | `challengeClaim`, `squadDeposit` (`lib/contract.ts`); agent API `stake`, `vote` | Every new position: browser, demo relay, oracle auto-challenge, council and trader personas | Creating markets, settlement, payouts, withdraw |
| `oracle_settlement` | `resolveClaim` (`lib/contract.ts`); the oracle poll skips its settle loop | Resolution of expired markets. The oracle also stops researching and calling the LLM for them | Oracle auto-challenge (governed by `stake`), payouts of markets that are already resolved, withdraw |
| `copy_execution` | `evaluateCopy` (`lib/copy-trading.ts`), which reads the switch itself | Every copied position (skip reason `global_paused`) | Creating and revoking copy permissions |
| `x402_selling` | `paidRoute` via `lib/x402/kill-switch.ts` | Paid endpoints answer `503` with `Retry-After: 60` rather than `402` | Free endpoints, council-pass requests |
| `x402_buying | `assertX402BuyingEnabled` (`lib/x402/buyer.ts`) | Agent purchases, refused before a paying client is built. `MIMIR_PAUSED_X402_BUYERS` pauses individual `G…` wallets | Callers treat a refused purchase as missing input and carry on without it |
| `research` | `gatewayFetch` (`lib/research/gateway.ts`) | Outbound source fetches. `RESEARCH_PAUSED_AGENT_IDs` pauses individual agents | Cached results already fetched |
| `agent_registration` | Agent API `register` | New BYOA registrations | Every call by already-registered agents |
| `market_creator_worker` | `reportingPoll` in `agents/market-creator` | The whole creation cycle | The process itself, plus its heartbeat |
| `council_worker` | `reportingPoll` in `agents/council` | The whole persona cycle | The process itself, plus its heartbeat |

**No switch on purpose:** `withdraw`, `claimChallengerPayout`, `claimFees`,
`squadClaim`, `squadWithdrawBeforeDeadline`, `cancelClaim`, every read path, and the
agent API's `revoke`, `revokeKey`, `revokeSpend`, `dryRun`, `proposeMarket` and
`heartbeat`. Users can always pull funds out, and owners can always contain a
compromised agent, including during the incident that paused everything else.

## Contract-level pause invariant

Mimir's Soroban contracts (`contracts-soroban/mimir-market` and
`contracts-soroban/mimir-squad`) treat contract state as the source of truth and
enforce a stronger, on-chain guarantee: **pause controls can never block withdrawals.**

The contract exposes a pause flag that gates only the "inflow" and
dispute-creation paths. The following operations are deliberately **not** gated by the
pause flag and must remain callable while the contract is paused:

| Operation (contract fn) | Work workspace | Why it must run while paused |
| --- | --- | --- |
| `withdraw` | mimir-market | Pushes a user's already-credited balance out of escrow |
| `claim_challenger_payout` | mimir-market | Settles a winning challenger from funds already locked |
| `claim_fees` | mimir-market | Releases fees already accrued to recipients |
| `cancel_claim` | mimir-market | Refunds the creator's stake when no challenge landed |
| `transition_deadline` | mimir-market | Turns an expired open claim into a creator refund |
| `squad_claim` | mimir-squad | Pays out a settled squad pool to its winners |
| `squad_withdraw_before_deadline` | mimir-squad | Returns a deposit to a depositor before settlement |

The pause flag only guards new money entering the contract (`create_claim`,
`challenge_claim`, `squad_deposit`) and oracle driven settlement (`settle_claim`). It
does not gate any path that moves already-committed funds back to their owner.

This is enforced in code by a single `pause::guard_inflow` helper that is called
only from the inflow and settlement entry points. Withdrawal and refund functions do not
call it, so they cannot be disabled by a pause flag even if an operator flips it by
mistake. The invariant is covered by tests that pause the contract and then assert
that every withdrawal/claim/refund path still succeeds and conserves total balances.

## Behavior

- `contract_pause` is a separate on-chain flag from the off-chain `MIMIR_PAUSE_` kill
switches. The off-chain switches stop Mimir's own callers; the on-chain flag is visible
to anyone who calls the contract directly. Neither can block a withdrawal.
- `contract_pause` is only settable by the owner and publishes a `PausedChanged` event
so it is auditable. Unpausing is always available to the owner and never timelocked,
because a stuck pause must not strand inflows forever.
- **Failure.** A paused contract write throws with the operator's reason or
`"<capability> is temporarily paused".` Paid endpoints answer `503`. The agent
API answers the standard retryable `agent_paused` error from
`lib/server/pause-registry.ts`, which carries `capability` and `viaGlobal`, so an
agent can branch without parsing the message. No response contains env names,
addresses or keys. A paused agent API call is audited as `rejected / paused` and
is checked before idempotent replay, so a cached success cannot be served while
paused. A paused worker logs one line per cycle
(`paused by MIMIR_PAUSE_…`) and records a healthy heartbeat. It does not exit,
because `npm run workers` runs with `--kill-others-on-fail` and one exit would
stop every worker.
- **Withdrawals always open.** While the contract is paused, `withdraw`,
`claim_challenger_payout`, `claim_fees`, `cancel_claim`, `transition_deadline`,
`squad_claim` and `squad_withdraw_before_deadline` all continue to work. This is the
contract-first accounting guarantee: pause is a valve on inflow, not a lock on
outflow.
- `contract_pause` is not set by any of the `MIMIR_PAUSE_` off-chain switches. It is
a separate operational action that requires an on-chain transaction from the owner.
- **Rollback.** Unset the variable, or set it to anything other than `1`. Nothing is
cached: the first call after the process sees the new environment goes through.
A paused settlement is delayed, never lost. Expired markets are settled on the
first oracle poll after the switch clears. On-chain, `unpause` clears the flag in a
single transaction.
- **Environment.** Switches are read from `process.env` at call time, so a flip
needs no code change or build. It takes effect once the service has the new
environment, which on Railway or Vercel means the restart or redeploy that
changing a variable triggers. Workers and the web app each need their own copy
of the variable.
- **Secrets.** None. A switch is a plain boolean, and no switch reads, logs or needs
a key.
- `contract_pause` is authorized by the owner address and is not a secret. It is
readable by anyone through the contract's public view.
- **Artifacts.** None. No build output, migration or contract change is involved.
The Soroban contracts are not aware of these off-chain switches: they stop Mimir's own
off-chain callers, not a user who calls the contract directly. The on-chain
pause flag is a distinct mechanism that never gates withdrawals.

## Verifying

From a clean checkout, with no `.env.local` and no network:

```sh
npm ci
npm run test:kill-switches
```

`tests/node/incident-kill-switches.test.ts` drives each switch at its enforcement
point. It checks that the capability runs when nothing is paused, stops under its
own switch and under `MIMIR_PAUSE_ALL`, and that pausing it leaves every other
capability running. It also checks that the exit paths above stay open with
everything paused. The probe table is typed as `Record<Pausable, Probe>`, so adding
a capability to `PAUSABLE` without wiring and testing it fails `npm run typecheck`.
The suite also runs as part of `npm run test:smoke` in CI.

For the on-chain invariant, run the focused contract tests and Wasm builds:

```sh
cargo test -p mimir-market pause
cargo test -p mimir-squad pause
cargo build --target wasm32-unknown-unknown -p mimir-market
cargo build --target wasm32-unknown-unknown -p mimir-squad
```

The contract pause tests assert that with the pause flag set, inflow and settlement
calls return `Paused`, while every withdrawal, claim and refund path still
succeeds and preserves total balances (conservation), and that authorization for
the pause flag is limited to the owner.
