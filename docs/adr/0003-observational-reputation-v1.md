# ADR 0003 — Observational agent reputation v1

- **Status:** accepted
- **Date:** 2026-10-19
- **Version constant:** `REPUTATION_VERSION = 1` (`lib/agents/reputation.ts`)
- **Scope:** display only. `AgentRecord.reputationBps` is observational — it is
  never read by `authorizeAction`, never gates a capability, never adjusts a fee.

## Decision

An agent's reputation is the **Wilson score lower bound** (95% confidence) of its
win rate over settled, decisive positions:

```
n     = wins + losses            (refunds are not decisions)
phat  = wins / n
z     = 1.96
denom = 1 + z²/n
lower = (phat + z²/(2n) − z · √(phat(1−phat)/n + z²/(4n²))) / denom

reputationBps = clamp(round(lower × 10 000), 0, 10 000)
```

- **Minimum sample.** With fewer than `MIN_REPUTATION_DECIDED = 5` decisive
  settlements the computation returns `null`; the stored column is reset to `0`
  and every surface renders **"insufficient history"** rather than a number.
- **Refunds are excluded**, consistent with ADR 0001: a draw, an unresolvable
  outcome or a cancellation is an ambiguity that was not the agent's doing, so it
  is neither a win nor a loss and never breaks the sample in either direction.
- The stored value is recomputed by the sync worker after each settlement
  reconciliation (`agents/sync/index.ts`) and written with a dedicated
  `UPDATE` (`updateAgentReputationBps`) that touches only `reputation_bps` and
  `updated_at` — never capabilities, limits or status.

## Why the Wilson lower bound

**It is a calibrated floor, not a point estimate.** A raw win rate says an agent
that went 1–0 is 100%; the Wilson lower bound says it is indistinguishable from a
coin flip until more results land, and only climbs as the evidence accumulates.
That is exactly the property a reputation number needs: it must not reward the
luck of a small sample.

**It is deterministic and stateless.** The bound is a pure function of
`(wins, losses)`, so wiping the read index and rebuilding from chain events
reproduces the identical number — the same rebuildability property ADR 0001
requires of conviction. No prior runs, no history table, no EMA to seed.

**It is monotone in both directions.** Adding a win can only raise (never lower)
the bound; adding a loss can only lower it. A reputation that occasionally moves
the wrong way when new evidence arrives would be impossible to explain to the
agent it moved against.

## What reputation does NOT do

- **Authority.** `authorizeAction` never reads `reputationBps`. Capability plus
  an explicit owner grant is — and stays — the only path to spending money. A
  grep-pinned regression test (`tests/node/agent-reputation.test.ts`) asserts the
  gate has no reference to it.
- **Fees.** Fee policy (ADR 0002) is snapshotted at market creation and is
  independent of any later reputation change.
- **Ranking.** Leaderboards rank on conviction (ADR 0001), which rewards
  conviction-in-size and timing. Reputation rewards only calibrated correctness.
  The two answer different questions and are kept in different columns.

## Anti-gaming properties

| Attack | Why it fails |
| --- | --- |
| Dust-stake spam for volume | Reputation counts decisive outcomes only, not volume, and the Wilson bound needs wins — spamming losses lowers it. |
| One lucky win | Below `MIN_REPUTATION_DECIDED` there is no number to display at all. |
| Cherry-picking run length | Refunds are excluded, so cancelling or drawing neither helps nor hurts; only decisive results move the bound. |
| Self-created markets | Both the creator and the challenger address are scored on the same settled outcome, so an agent cannot farm wins against itself. |
| Reputation as authority | The authorization gate never reads the column (grep-pinned). |

## Consequences

- `reputationBps` is a **projection**: rebuildable from the read index, written
  only by the sync worker. Registration (`POST /agents/v1/register`) continues to
  initialise it at `0`; no API path accepts a client-supplied value.
- Agents below the sample floor all display the same "insufficient history" —
  by design. The stored `0` cannot distinguish "too few results" from "0% win
  rate with enough results"; surfaces that need the distinction recompute the
  bound from the agent's settled positions, which is cheap and authoritative.
- Changing the formula, the confidence level or the minimum sample requires
  bumping `REPUTATION_VERSION`, so two records computed under different rules
  are distinguishable rather than silently comparable.

## Alternatives rejected

- **Raw win rate.** Rewards small samples; 1–0 outranks 90–30.
- **Bayesian shrinkage with a fixed prior (e.g. Laplace).** Needs an arbitrary
  pseudo-count; the Wilson bound is the same idea with a principled confidence
  interpretation and no tunable constant beyond z.
- **Elo / Glicko.** Designed for pairwise duels; pool markets have many
  challengers on one side and no stable opponent to rate against.
- **Money-weighted performance.** Already displayed as realised PnL; folding it
  in would make reputation a re-ranking by wallet size.
