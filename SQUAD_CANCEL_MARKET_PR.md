# PR #23: Squad Market Refund Feature

**Title**: `feat(contracts): refund cancelled squad markets`

**Status**: Ready for review  
**Date**: 2026-09-24  
**Contracts affected**: `contracts-soroban/mimir-squad`

---

## Summary

This PR adds captain-initiated market cancellation to the Soroban squad pool contract. When a captain cancels an unresolved market, all participants receive full refunds of their principal via pull-based claims. No fees are charged on cancellation, and the escrow accounting is preserved for audit purposes.

**Design pattern**: Mirrors the existing `cancel_claim` pattern from `mimir-market`, but adapted for two-sided pools.

---

## Changes

### 1. Core Implementation

**File**: `contracts-soroban/mimir-squad/src/pool.rs`

Added public function:
```rust
pub fn cancel_market(env: &Env, market_id: u64) -> Result<(), Error>
```

**Logic**:
1. Fetch market, enforce captain signature
2. Check market not already resolved → return `AlreadyResolved` if resolved
3. Snapshot pools for event audit trail
4. Set `resolved = true`, `result = RESULT_CANCELLED`
5. Publish `MarketCancelled` event
6. Return success

Participants then call `claim(participant, market_id, side)` to pull their refunds. The existing `claim()` function handles `RESULT_CANCELLED` by:
- Checking `side != market.result` is waived (participants can claim regardless of side choice)
- Returning `gross = principal` (no winner pool calculation)
- Returning `fee = 0` (no profit fee on cancellation)
- Transferring `net = principal` back to the claimant

**Escrow accounting**:
- Before cancel: escrow holds all deposits
- During cancel: pools and remaining_escrow remain unchanged (audit trail preserved)
- After claims: funds flow from escrow to participants per existing pull logic
- Invariant: `escrow_balance_before - (pool_a + pool_b) == escrow_balance_after`

### 2. Types

**File**: `contracts-soroban/mimir-squad/src/types.rs`

Added error variant:
```rust
pub enum Error {
    // ... existing errors ...
    AlreadyResolved = 27,  // market is already settled, cannot cancel
}
```

### 3. Events

**File**: `contracts-soroban/mimir-squad/src/events.rs`

Added event:
```rust
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MarketCancelled {
    #[topic]
    pub market_id: u64,
    #[topic]
    pub captain: Address,
    pub pool_a: i128,
    pub pool_b: i128,
}
```

**Topics**: Market ID and captain (for filtering and authorization audit)  
**Non-indexed**: Pools snapshot (for escrow reconciliation)

### 4. Public Interface

**File**: `contracts-soroban/mimir-squad/src/contract.rs`

Added public method:
```rust
pub fn cancel_market(env: Env, market_id: u64) -> Result<(), Error> {
    pool::cancel_market(&env, market_id)
}
```

### 5. Tests

**File**: `contracts-soroban/mimir-squad/src/test_cancellation.rs` (411 lines)

**Test coverage**: 25 tests across 5 categories

**Positive tests**:
- Basic cancellation (empty market, single-sided, both sides)
- Multi-participant scenarios (multiple on one side, topups, both sides)
- Authority and event validation

**Negative tests**:
- Authorization failure (non-captain rejection)
- State gating (already resolved)
- Not found (unknown market)
- Double cancel prevention

**Edge cases**:
- Retry claims (already claimed returns 0)
- Non-depositor claims (rejected)
- Deadline-inclusive cancellation
- No fee accrual on cancellation

**Invariants**:
- Escrow conservation through full refund lifecycle
- Pool immutability after cancellation
- Per-participant refund accuracy

**Updated**: `contracts-soroban/mimir-squad/src/lib.rs` to include `mod test_cancellation`

---

## Accounting & Trust Model

### Fund Flow

```
Participant → deposit → Escrow (contract holds)
                         ├─ pool_a (SIDE_A deposits)
                         ├─ pool_b (SIDE_B deposits)
                         └─ accrued_fees (from settlement only)

[On normal resolve]
→ remaining_escrow = pool_a + pool_b
→ For each winner: gross calculation, fee deduction, pull payout
→ Escrow decreases

[On cancel_market]
→ resolved = true, result = RESULT_CANCELLED
→ Pools unchanged
→ For each depositor: pull full principal via claim()
→ Escrow decreases to zero

Invariant check:
  escrow_balance_final = escrow_balance_initial - (pool_a + pool_b)
```

### Authorization Model

| Operation | Authority | Pre-condition | Result |
|-----------|-----------|---------------|--------|
| `cancel_market` | Captain signature | Market not resolved | Market transitions to cancelled state |
| `claim` (cancelled) | Participant signature | Market resolved + result=RESULT_CANCELLED | Full principal returned, no fee |

**Key property**: Cancellation is non-profitable. No fees are charged. The escrow holds what was deposited and returns exactly that.

### State Transitions

```
Market {
  resolved: false → true
  result: 0 → RESULT_CANCELLED
  pool_a: unchanged (audit trail)
  pool_b: unchanged (audit trail)
  remaining_escrow: unchanged
  participants_a: unchanged
  participants_b: unchanged
}
```

---

## Compatibility & Migration

### Backward Compatibility

✅ **No breaking changes**:
- New function, no signature changes to existing operations
- Existing workflows (`deposit`, `resolve`, `claim` on normal settlements) unaffected
- New error type added but only returned by new function
- New event type published but does not interfere with existing ones

### On-Chain State

✅ **No migration required**:
- No schema changes to existing storage keys
- No TTL bumps needed beyond current lifecycle
- Pool, escrow, and deposit structures unchanged
- Fee accrual logic unchanged (cancellation doesn't accrue fees)

### Operational Rollback

If needed:
1. Remove the `cancel_market()` method from `contract.rs`
2. Remove the `pub fn cancel_market()` from `pool.rs`
3. Redeploy contract
4. Existing markets are unaffected (state already in Stellar ledger)
5. Markets in cancelled state can still be claimed (claim() handles RESULT_CANCELLED)

---

## Testing Checklist

### Unit Tests

- [x] 25 test cases in `test_cancellation.rs`
- [x] Positive: basic, multi-participant, topup scenarios
- [x] Negative: auth, state, not found
- [x] Edge: retry, non-depositor, deadline, no fees
- [x] Invariants: escrow conservation, pool immutability

### Code Review Checklist

- [x] Authorization: `captain.require_auth()` enforced
- [x] State gating: `AlreadyResolved` error on second cancel
- [x] Escrow accounting: conservation invariant holds
- [x] Events: Published with correct topics and fields
- [x] Error handling: New error type propagated correctly
- [x] Public interface: Added to contract impl
- [x] Documentation: Comments on public function

### Acceptance Criteria

- [x] Feature available through existing interface
- [x] No breaking changes to compatible callers
- [x] Money movement explicit and tested
- [x] Permissions explicit (captain required)
- [x] Privacy boundaries respected
- [x] Types updated (new error)
- [x] Migrations handled (none needed)
- [x] Positive tests pass
- [x] Negative tests pass
- [x] Boundary tests pass
- [x] Conservation tests pass
- [x] Regression: Existing operations still work

---

## Code Locations

| Component | File | Details |
|-----------|------|---------|
| Implementation | `src/pool.rs` | `pub fn cancel_market()` at line ~283 |
| Interface | `src/contract.rs` | `pub fn cancel_market()` at line ~60 |
| Error type | `src/types.rs` | `AlreadyResolved = 27` at line ~60 |
| Event | `src/events.rs` | `MarketCancelled` struct at end of file |
| Tests | `src/test_cancellation.rs` | Full 411-line test suite |
| Module registration | `src/lib.rs` | `mod test_cancellation` added |

---

## Deployment Notes

### For Developers

1. **Build**: `cargo build --release` (no new dependencies)
2. **Test**: `cargo test --release` (all tests should pass)
3. **Deploy**: Push new WASM to testnet/mainnet via existing deploy process
4. **Announce**: Add `cancel_market` to contract reference docs

### For Operations

- **No configuration changes**: No env vars, no feature flags
- **No rollout phases**: Safe to deploy to all networks at once
- **Monitoring**: Watch for `MarketCancelled` events on dashboard (new event type)
- **Support**: Existing support processes work (cancellation is user-initiated, not system-triggered)

### For the Product Layer

**New UI flows available**:
- Captain dashboard: "Cancel market" button on Open/Active markets
- Explorer: Show cancellation as a settlement state (like "Resolved")
- Settlement receipt: Display "Cancelled" verdict alongside "Creator Wins" / "Challenger Wins"

**No changes required to**:
- Deposit UI (no change)
- Withdrawal UI (no change)
- Claim UI (existing claim() handles cancelled markets)
- Statistics (cancellation is not a payout event)

---

## Audit Trail

### Event-Based Reconciliation

For any market, off-chain systems can reconstruct the full history:

1. **MarketCreated**: Initial state, captain, question, deadline
2. **Deposited**: Each participant, side, amount (all captured)
3. Either:
   - **Resolved**: Oracle-driven settlement, winner_side, pools, result
   - **MarketCancelled**: Captain-driven cancellation, pool snapshot
4. **Claimed**: Each claimant, participant, gross, fee, net

**Invariant check** (off-chain):
```
For each market:
  total_deposits = sum(Deposited events)
  escrow_initial = total_deposits
  
  if Resolved:
    remaining_escrow = pool_a + pool_b
    total_claimed = sum(Claimed events where net > 0)
    total_fees = sum(Claimed events where fee > 0)
    assert: total_claimed + total_fees == remaining_escrow
    
  if MarketCancelled:
    total_claimed = sum(Claimed events where net > 0)
    assert: total_claimed == total_deposits (full refund)
    assert: sum(fees in Claimed) == 0 (no fees on cancel)
```

---

## Questions & Answers

**Q: Why not automatically refund participants on cancel_market?**  
A: Pull-based refunds match the existing payout pattern and handle frozen trustlines gracefully. One account's broken USDC trustline won't block other participants.

**Q: Why not store a participant roster?**  
A: The current design avoids O(n) storage mutations per deposit/withdrawal. Participants are discovered off-chain via Claimed events, and the test suite validates that claim() is called per participant.

**Q: What if a captain cancels by accident?**  
A: Participants must actively claim their refunds. A cancelled market is permanent (resolved=true), but funds are always refundable. There's no time lock on claims. The event log provides clear audit trail.

**Q: How do fees work on cancelled markets?**  
A: No fees are charged. `market.result = RESULT_CANCELLED` in claim() sets `fee = 0` for all claimants regardless of the fee_bps field.

**Q: Is the deadline relevant for cancellation?**  
A: No. A captain can cancel before, at, or (theoretically) after the deadline. Only the `resolved` flag matters. This gives captains flexibility if a market becomes ambiguous or irrelevant.

---

## References

- **Feature spec**: `/SQUAD_CANCEL_FEATURE_ANALYSIS.md` (comprehensive design document)
- **Related feature**: `mimir-market` `cancel_claim()` (Soloidity original pattern)
- **Test patterns**: `test_lifecycle.rs`, `test_payouts.rs` (existing test suite)
- **Accounting**: `ECONOMIC_INVARIANTS.md` (platform-wide conservation rules)

---

## Sign-Off

**Author**: Senior Development AI  
**Implementation Date**: 2026-09-24  
**Code Review**: Ready for peer review  
**Status**: All acceptance criteria met, tests pass, ready to merge

---

## Related Issues

Closes: Issue #23 - Squad market refund feature
