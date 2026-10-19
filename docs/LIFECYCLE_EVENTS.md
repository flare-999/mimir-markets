# Lifecycle Events Reference

This document describes the typed lifecycle events published by the Mimir contracts for market lifecycle tracking, accounting reconciliation, and operational monitoring.

## Overview

Both `mimir-market` and `mimir-squad` contracts emit comprehensive lifecycle events that capture state transitions, liquidity changes, and key operational milestones. These events provide:

- **Contract-first accounting**: Every state change, fund movement, and settlement is recorded on-chain
- **Clear market semantics**: Explicit state transitions with timestamps
- **Safe agent operations**: Observable triggers for oracle workers and indexers
- **Audit trail**: Complete history for reconciliation and incident response

## mimir-market Events

### Core Lifecycle Events

#### ClaimStateTransitioned
Emitted on every claim state change. Tracks transitions between `Open`, `Active`, `Resolved`, and `Cancelled` states.

**Fields:**
- `id` (topic): Claim ID
- `from_state`: Previous state (u32 enum value)
- `to_state`: New state (u32 enum value)
- `timestamp`: Ledger timestamp when transition occurred

**State Values:**
- 0 = Open
- 1 = Active
- 2 = Resolved
- 3 = Cancelled

**Emitted by:**
- `challenge_claim`: Open → Active (on first challenge)
- `transition_deadline`: Open → Cancelled (for expired unchallenged claims)
- `cancel_claim`: Open → Cancelled (creator-initiated cancellation)
- `resolve_claim`: Active → Resolved (oracle settlement)

#### DeadlineReached
Emitted when a claim's deadline passes and it becomes eligible for resolution or cancellation.

**Fields:**
- `id` (topic): Claim ID
- `deadline`: The deadline timestamp that was reached
- `challenger_count`: Number of challengers at deadline
- `total_staked`: Total funds in escrow (creator + all challengers)

**Emitted by:**
- `transition_deadline`: For unchallenged claims entering cancellation
- `resolve_claim`: For active claims entering settlement window

**Usage:** Indexers and oracle workers use this event to identify claims ready for settlement without polling every claim.

#### EscrowSeeded
Emitted when initial escrow is established or topped up for a claim.

**Fields:**
- `id` (topic): Claim ID
- `funder` (topic): Address providing the escrow
- `amount`: USDC amount in atomic units (7 decimals)
- `escrow_type`: String indicating escrow purpose

**Escrow Types:**
- `"creator_stake"`: Creator's initial stake at claim creation
- `"challenger_stake"`: Challenger's stake when joining the market

**Emitted by:**
- `create_claim`: When creator funds the initial stake
- `challenge_claim`: When each challenger adds their stake

**Usage:** Accounting reconciliation can verify that contract escrow balance equals the sum of all `EscrowSeeded` events minus payouts and refunds.

#### LiquidityUpdated
Emitted on fixed-odds liquidity state changes beyond initial reservations.

**Fields:**
- `id` (topic): Claim ID
- `reserved_liability`: Total creator liability reserved for all challengers
- `available_liquidity`: Creator stake remaining after reservations
- `total_creator_stake`: Original creator stake amount

**Emitted by:**
- Future extensions for dynamic liquidity management
- Currently reserved for fixed-odds markets that modify liquidity post-creation

**Usage:** Risk management and UI display of available liquidity in fixed-odds markets.

### Existing Events Enhanced

The following existing events work together with lifecycle events:

- **ClaimCreated**: Initial claim setup, now paired with `EscrowSeeded`
- **ClaimChallenged**: Challenge acceptance, now paired with `EscrowSeeded` and `ClaimStateTransitioned`
- **ClaimResolved**: Settlement result, now paired with `ClaimStateTransitioned` and `DeadlineReached`
- `**ClaimCancelled**: Cancellation completed, now paired with `ClaimStateTransitioned`

## mimir-squad Events

### Pool Lifecycle Events

#### MarketStateTransitioned
Emitted on every pool market state change. Tracks transitions between active and resolved states.

**Fields:**
- `market_id` (topic): Market ID
- `from_state`: Previous state (0 = Active, 2 = Resolved)
- `to_state`: New state (0 = Active, 2 = Resolved)
- `timestamp`: Ledger timestamp when transition occurred

**Emitted by:**
- `transition_deadline`: Active → Resolved (for one-sided markets)
- `resolve`: Active → Resolved (oracle settlement)

#### MarketDeadlineReached
Emitted when a pool market's deadline passes and it becomes eligible for resolution.

**Fields:**
- `market_id` (topic): Market ID
- `deadline`: The deadline timestamp that was reached
- `pool_a_total`: Side A pool total in atomic USDC
- `pool_b_total`: Side B pool total in atomic USDC

**Emitted by:**
- `transition_deadline`: For one-sided markets entering cancellation
- `resolve`: For normal markets entering settlement

**Usage:** Oracle workers identify markets ready for resolution. Indexers use pool totals for analytics without reading contract state.

#### LiquidityAdded
Emitted when liquidity is deposited into a pool market.

**Fields:**
- `market_id` (topic): Market ID
- `side` (topic): Side receiving liquidity (1 = A, 2 = B)
- `amount`: USDC amount added
- `new_pool_total`: Pool total after this deposit
- `shares_issued`: Shares issued to depositor (equals amount in squad v1)

**Emitted by:**
- `deposit`: Every liquidity addition to either side

**Usage:** Track pool depth over time, calculate TVL, monitor liquidity provision patterns.

#### LiquidityRemoved
Emitted when liquidity is withdrawn from a pool market before resolution.

**Fields:**
- `market_id` (topic): Market ID
- `side` (topic): Side losing liquidity (1 = A, 2 = B)
- `amount`: USDC amount withdrawn
- `new_pool_total`: Pool total after this withdrawal
- `shares_burned`: Shares burned from withdrawer (equals amount in squad v1)

**Emitted by:**
- `withdraw_before_deadline`: Pre-deadline withdrawals only

**Usage:** Distinguish between pre-deadline liquidity exits (this event) and post-resolution claims (which use the `Claimed` event).

#### MarketCancelled
Emitted when the captain cancels a market before its deadline.

**Fields:**
- `market_id` (topic): Market ID
- `captain` (topic): Captain who cancelled
- `pool_a`: Side A pool at cancellation (kept for the audit trail)
- `pool_b`: Side B pool at cancellation

**Emitted by:**
- `cancel_market`: only before the deadline; seeds `remaining_escrow = pool_a + pool_b` so every depositor can pull a full refund through `claim`

#### PayoutParked
Emitted when a payout cannot be delivered (frozen or deauthorized trustline) and is parked for a later `claim_parked_payout`.

**Fields:**
- `market_id` (topic): Market ID
- `side` (topic): Side claimed
- `participant` (topic): Winner whose payout was parked
- `amount`: Net amount parked

#### SquadFull
Emitted on the deposit that fills the squad to `MAX_SQUAD_MEMBERS`.

**Fields:**
- `market_id` (topic): Market ID
- `total_members`: Members across both sides

#### OracleQueued / OracleCancelled / OracleChanged
Oracle rotation timelock: `queue_oracle` (topic `next`, `executable_at`), `cancel_oracle` (`cancelled`), `execute_oracle` (topic `next`, `previous`).

### Fee Recipient Rotation Events

The squad `fee_recipient` can be rotated without redeploying, using the same timelock pattern as oracle rotation. Only the current fee recipient may queue or cancel a rotation, and the change cannot execute before the timelock elapses.

##### FeeRecipientQueued
Emitted when the current fee recipient queues a rotation to a new recipient.

**Fields:**
- `next` (topic): The proposed new fee recipient
- `executable_at`: Ledger timestamp before which the rotation cannot execute

**Emitted by:**
- `queue_fee_recipient`: authorised only by the current fee recipient

**Usage:** Indexers and operators use this event to surface pending rotations and to schedule execution after the timelock.

##### FeeRecipientCancelled
Emitted when the current fee recipient cancels a pending rotation.

**Fields:**
- `cancelled`: The previously queued recipient address that was cancelled

**Emitted by:**
- `cancel_fee_recipient`: authorised only by the current fee recipient

**Usage:** Confirms that no rotation is pending after cancellation.

##### FeeRecipientChanged
Emitted when a queued rotation is executed after the timelock.

**Fields:**
- `next` (topic): The new fee recipient
- `previous`: The previous fee recipient

**Emitted by:**
- `execute_fee_recipient`: authorised only by the current fee recipient, and only after the timelock has elapsed

**Accounting note:** Accrued but unclaimed fees at execution time go to the new recipient. The rotation changes the destination of `fee_recipient_accrued` at execution; future `claim_fees` calls pay the new recipient.

**Usage:** Indexers use this event to update the active fee recipient and to reconcile fee claims against the correct recipient.

### Existing Events Enhanced

The following existing events work with lifecycle events:

- **MarketCreated**: Initial market setup
- **Deposited**: Now paired with `LiquidityAdded`
- `**Withdrawn**: Now paired with `LiquidityRemoved`
- **Resolved**: Now paired with `MarketStateTransitioned` and `MarketDeadlineReached`

## Integration Guidelines

### For Indexers

1. **State Tracking**: Use `ClaimStateTransitioned` and `MarketStateTransitioned` as the source of truth for lifecycle state
2. **Conservation Checks**: Sum `EscrowSeeded` amounts and verify against payouts and remaining escrow
3. **Deadline Monitoring**: Listen to `DeadlineReached` and `MarketDeadlineReached` to identify claims needing oracle attention
4. **Pool Analytics**: Track `LiquidityAdded` and `LiquidityRemoved` for TVL, liquidity depth charts, and participation patterns
5. **Fee Recipient Rotation**: Track `FeeRecipientQueued`, `FeeRecipientCancelled`, and `FeeRecipientChanged` to know which address is entitled to accrued fees

### For Oracle Workers

1. **Settlement Queue**: Subscribe to `DeadlineReached` and `MarketDeadlineReached` events instead of polling all claims
2. **State Validation**: Check `ClaimStateTransitioned` to confirm a claim reached `Active` before attempting resolution
3. **Accounting Verification**: Cross-reference `EscrowSeeded` events with expected escrow balance before settlement

### For Frontend / UI

1. **Real-time Updates**: Subscribe to lifecycle events to update UI state without refetching entire claim data
2. **Liquidity Display**: Use `LiquidityAdded` / `LiquidityRemoved` for live pool depth indicators
3. **Status Badges**: Map `ClaimStateTransitioned` to user-facing status labels
4. **Fee Recipient Rotation**: Surface the pending recipient and `executable_at` from `FeeRecipientQueued`, and confirm the active recipient from `FeeRecipientChanged`

### For Analytics

1. **Market Health**: Track state transition timing to measure average time-to-challenge, time-to-settlement
2. **Liquidity Patterns**: Analyze `LiquidityAdded` / `LiquidityRemoved` timing relative to deadlines
3. **Escrow Flows**: Build cash flow statements from `EscrowSeeded`, `Claimed`, `Withdrawn`, and `ChallengerPaid` events
4. **Fee Recipient History**: Use `FeeRecipientChanged` to attribute fee claims to the correct recipient over time

## Event Ordering Guarantees

Within a single transaction:

1. **Create**: `EscrowSeeded` → `ClaimCreated` → `FeePolicySnapshotted`
2. **Challenge**: `EscrowSeeded` → `ClaimStateTransitioned` (if Open → Active) → `FixedOddsLiquidityReserved` (if applicable) → `ClaimChallenged`
3. **Resolve**: `DeadlineReached` → `ClaimStateTransitioned` (Active → Resolved) → `MarketSettled` → `ClaimResolved` → `VerdictEncoded`
4. **Cancel**: `ClaimStateTransitioned` (Open → Cancelled) → `ClaimCancelled`
5. **Pool Deposit**: `LiquidityAdded` → `Deposited`
6. **Pool Withdraw**: `LiquidityRemoved` → `Withdrawn`
7. **Pool Resolve**: `MarketDeadlineReached` → `MarketStateTransitioned` → `Resolved`
8. **Fee Recipient Rotation**: `FeeRecipientQueued` → `FeeRecipientCancelled` → `FeeRecipientChanged`

## Migration Notes

### Compatibility

- Existing indexers continue to work: legacy events (`ClaimCreated`, `ClaimResolved`, etc.) are unchanged
- New events are additive: no breaking changes to event schemas
- State enums match existing `ClaimState` and implicit market states

### Rollout

1. Deploy updated contract with new events
2. Update indexers to subscribe to lifecycle events (old events remain available)
3. Update oracle workers to use `DeadlineReached` triggers
4. Backfill: Historical claims have state transitions implicit in existing events

### Accounting Audit

For claims created after lifecycle events deployment:

```
Sum(EscrowSeeded.amount) = 
  Sum(ChallengerPaid.net) + 
  Sum(ClaimCancelled.refund) + 
  Sum(FeeAccrued.amount) + 
  MarketSettled.dust + 
  MarketSettled.owed_to_challengers (if not yet fully claimed)
```

## Security Considerations

### Event Trust

- `**On-chain source of truth**: Events reflect committed storage, not speculative state
- ``**No front-running**: Events are emitted after auth checks and state validation
- ``**Idempotent resolution**: Duplicate `resolve_claim` calls with identical inputs do not re-emit events

### Privacy

- `**No private data**: Invite key hashes are not exposed in events; only the hash is stored/emitted
- ``**Address exposure**: All events with funder/participant addresses are public; private claims remain identified only by on-chain activity

### Defensive Events

- ``**CancellationRefused**: Emitted when `cancel_claim` detects counterparty exposure or insolvency; nothing is changed on-chain, event is the audit trail
- ``**Conservation assertions**: Lifecycle events follow accounting conservation checks; if emitted, conservation holds

## Testing

See contract test files:
- `mimir-market/src/test_lifecycle.rs`: State transition coverage
- `mimir-market/src/test_settlement.rs`: Resolution and payout event verification
- `mimir-squad/src/test_lifecycle.rs`: Pool market lifecycle
- `mimir-squad/src/test_payouts.rs`: Pool payout event ordering
- `mimir-squad/src/test_fee_recipient_rotation.rs`: Fee recipient rotation queue/cancel/execute/unauthorised paths and `claim_fees` after rotation

Event assertions confirm:
- Correct state transition sequences
- Event field values match committed state
- Event ordering within transactions
- Conservation invariants after each lifecycle step
