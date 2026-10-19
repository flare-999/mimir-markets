# Squad Market Cancellation Feature — Comprehensive Analysis

**Status**: Design phase for PR #23  
**Current Date**: 2026-09-24

---

## 1. Executive Summary

The Mimir squad contract (`mimir-squad`) manages two-sided USDC pools with captain-led markets. Currently, once a market is created, it can only be resolved (winner decided) or left unresolved indefinitely. This feature adds captain-initiated market cancellation with full principal refunds to all depositors, mirroring the existing `cancel_claim` pattern from `mimir-market`.

**Key invariant**: Cancellation is a non-profit refund operation that must preserve escrow accounting and provide an audit trail through events.

---

## 2. Current Architecture

### 2.1 mimir-squad State Machine

```
Created → Deposit/Withdraw (pre-deadline) → Resolved or Cancelled
                                                ↓
                                            Pull Payouts
```

**Market struct** (`types.rs`):
```rust
pub struct Market {
    pub captain: Address,           // Creator of the market
    pub deadline: u64,              // Unix timestamp, no deposits after
    pub fee_bps: u32,               // Fee on profit only (0-1000 bps)
    pub result: u32,                // 0 (unresolved), SIDE_A (1), SIDE_B (2), RESULT_CANCELLED (3)
    pub resolved: bool,             // true = settlement started
    pub pool_a: i128,               // Total deposits on SIDE_A
    pub pool_b: i128,               // Total deposits on SIDE_B
    pub remaining_escrow: i128,     // Funds owed to winners after resolve
    pub participants_a: u32,        // Count of unique addresses on side A
    pub participants_b: u32,        // Count of unique addresses on side B
    pub winner_claims: u32,         // How many winners have claimed so far
}
```

**Key constants**:
- `SIDE_A = 1`, `SIDE_B = 2`, `RESULT_CANCELLED = 3`
- `MAX_FEE_BPS = 1_000` (10% ceiling)
- `USDC_DECIMALS = 7`
- `MAX_PARTICIPANTS_PER_SIDE = 200`

### 2.2 Deposit Tracking

Storage keys for each participant's position:
```rust
pub enum DataKey {
    Deposit(u64, side, Address),    // market_id, side, participant → amount (i128)
    Claimed(u64, side, Address),    // market_id, side, participant → bool (has pulled payout)
}
```

**Key design**: Shares equal deposited units (1:1). No separate accounting for shares vs. USDC.

### 2.3 Existing Lifecycle Operations

| Operation | Auth | Pre-condition | Post-condition |
|-----------|------|---------------|----------------|
| `create_market` | captain | — | market created, no deposits |
| `deposit` | participant | market not resolved, before deadline | funds move to escrow, balance updated |
| `withdraw_before_deadline` | participant | before deadline, unresolved | funds return to participant |
| `resolve` | oracle | deadline passed, not yet resolved | `resolved=true`, `remaining_escrow` seeded |
| `claim` | participant | resolved, not yet claimed on that side | net payout transferred, fees accrued |
| `claim_fees` | fee_recipient | — | accrued fees transferred |

### 2.4 Comparison: mimir-market Cancellation

The existing `cancel_claim` in mimir-market shows the pattern we adapt:

```rust
pub fn cancel_claim(env: &Env, claim_id: u64) -> Result<(), Error> {
    let mut claim = storage::get_claim(env, claim_id)?;
    claim.creator.require_auth();
    if claim.state != ClaimState::Open {
        return Err(Error::ClaimNotOpen);
    }

    claim.state = ClaimState::Cancelled;
    let creator = claim.creator.clone();
    let refund = claim.creator_stake;
    storage::set_claim(env, claim_id, &claim);

    // Cancellation is a refund: no fee.
    let usdc = storage::usdc(env)?;
    escrow::push_or_park(env, &usdc, &creator, refund);

    events::ClaimCancelled { id: claim_id }.publish(env);
    Ok(())
}
```

**Key takeaways**:
1. Only creator (or captain) can cancel
2. Can only cancel if market is in specific state (not too late)
3. Refund is full principal, no fees
4. Uses `escrow::push_or_park()` for safe fund transfer (handles frozen trustlines)
5. Single event published for audit trail

---

## 3. Design: Squad Market Cancellation

### 3.1 Functional Requirements

**What the feature does**:
- Captain can cancel a market that hasn't been resolved yet
- All depositors on both sides receive full refund of their principal
- No fees are charged on cancellation (refund operation, not settlement)
- Result is set to `RESULT_CANCELLED` and `resolved` becomes `true`
- Full audit trail via events

**What it doesn't do**:
- Cancel a market after deadline (too late to change outcome meaningfully)
- Cancel a market that's already resolved
- Refund partial amounts or apply fees
- Allow captain to redirect funds (all go back to depositors)

### 3.2 Authorization and State Gating

```
cancel_market(market_id)
├─ Require captain signature
├─ Fetch market
├─ Check: not resolved yet
├─ Check: can cancel (optional: not past deadline)
└─ If OK:
   ├─ Set resolved=true, result=RESULT_CANCELLED
   ├─ For each (side, participant) with deposit > 0:
   │  ├─ Refund full amount to participant
   │  └─ Clear deposit storage entry
   ├─ Publish MarketCancelled event
   └─ Return success
```

**Boundary cases**:
1. Market not found → `Error::MarketNotFound`
2. Market already resolved → `Error::AlreadyResolved` (new)
3. Captain not signatory → Soroban auth fails automatically
4. No deposits → Still succeeds, market just transitions state

### 3.3 Error Handling

**New error type needed**:
```rust
pub enum Error {
    // ... existing errors ...
    AlreadyResolved = 27,  // market is already settled, cannot cancel
}
```

**Existing errors that apply**:
- `NotInitialized` → contract not initialized
- `MarketNotFound` → market_id doesn't exist
- Soroban auth rejection → captain didn't sign

### 3.4 Storage & Escrow Accounting

**Key invariant** (must hold before and after):
```
escrow balance == pool_a + pool_b + accrued_fees
```

**During cancellation**:
1. Set `resolved=true` (prevents future state transitions)
2. Set `result=RESULT_CANCELLED`
3. For each depositor on both sides, push full deposit amount back
4. Do NOT mutate pools or remaining_escrow (only for normal resolution)

**Why this works**:
- `remaining_escrow` stays at `0` (was never set, since we didn't resolve)
- Pools remain accurate for audit trail
- All funds flow directly from escrow to participants
- No fee accrual (cancellation is not a settlement)

### 3.5 Event Design

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

**Why these fields**:
- `market_id`: Index the event for market history
- `captain`: Who initiated (authorization audit)
- `pool_a`, `pool_b`: Total amounts being refunded (escrow audit)

---

## 4. Implementation Strategy

### 4.1 Code Changes

**File: `contracts-soroban/mimir-squad/src/pool.rs`**
- Add `pub fn cancel_market(env: &Env, market_id: u64) -> Result<(), Error>`
- Logic:
  1. Get market, check captain auth
  2. Validate state (`not resolved`)
  3. Build refund list (iterate participants on both sides)
  4. Set market state to cancelled
  5. For each participant, push full deposit back
  6. Publish event

**File: `contracts-soroban/mimir-squad/src/contract.rs`**
- Add public method to contract interface

**File: `contracts-soroban/mimir-squad/src/types.rs`**
- Add `AlreadyResolved` error variant

**File: `contracts-soroban/mimir-squad/src/events.rs`**
- Add `MarketCancelled` event struct

### 4.2 Key Design Decisions

1. **Pull refunds per participant vs. single transfer**:
   - **Chosen**: Per-participant (matches claim() pattern)
   - **Reason**: Handles frozen trustlines gracefully, prevents one account blocking all others

2. **Immutable pools during cancellation**:
   - **Chosen**: Don't mutate `pool_a`, `pool_b`
   - **Reason**: Audit trail, simpler accounting, matches mimir-market (doesn't mutate escrow)

3. **Iterate both sides**:
   - **Chosen**: Explicit loop over SIDE_A and SIDE_B
   - **Reason**: Clear, predictable gas cost, no need to store participant list separately

4. **Set result to RESULT_CANCELLED**:
   - **Chosen**: Yes, explicit marker
   - **Reason**: Makes cancelled state discoverable without reading resolved flag

---

## 5. Testing Strategy

### 5.1 Positive Cases

1. **Basic cancellation**: Captain cancels, all depositors refunded
   - Verify: escrow balance decreases, participant balances increase
   - Verify: market.resolved=true, market.result=RESULT_CANCELLED

2. **Empty market**: Cancel a market with no deposits
   - Verify: Succeeds, event published, no refunds needed

3. **Single-sided market**: Cancel with deposits on only one side
   - Verify: Correct refunds, only that side's participants refunded

4. **Both sides populated**: Multiple participants per side, mixed topup history
   - Verify: Each participant refunded exactly their deposit, no double-counting

5. **Pre-deadline and at-deadline**:
   - Verify: Both timestamps allow cancellation (no deadline-based rejection)

### 5.2 Negative Cases

1. **Not captain**: Non-captain tries to cancel
   - Verify: Soroban auth fails

2. **Already resolved**: Cancel after resolve()
   - Verify: Error::AlreadyResolved

3. **Unknown market**: Cancel market_id=999
   - Verify: Error::MarketNotFound

4. **Multiple calls**: Captain calls cancel twice on same market
   - Verify: First succeeds, second fails (already resolved)

### 5.3 Invariants

1. **Conservation**: `escrow_balance_before - (pool_a + pool_b) == escrow_balance_after`
2. **No double-refund**: Each participant with deposit > 0 gets exactly one refund
3. **Participant list consistency**: `has_claimed` flags are not checked (pre-resolution) or handled gracefully

### 5.4 Test File: `test_cancellation.rs`

Will follow the pattern of `test_lifecycle.rs` using the `Fixture` helper.

---

## 6. Operational Impact

### 6.1 Migration & Rollback

- **No database migration needed**: Contract storage is isolated
- **Feature gate**: None required (backward compatible add-operation)
- **Rollback**: Remove function from contract and redeploy (non-breaking)

### 6.2 Monitoring & Alerts

**Metrics to track**:
- Count of `MarketCancelled` events per day
- Median pool size at cancellation
- Captain cancel rate vs. resolved rate

**Operational notes**:
- Cancellation is a captain-only action; no permission escalation
- Refunds are pull-based so won't fail on frozen accounts
- No fee accrual during cancellation

### 6.3 Documentation Updates

- Update contract README: Add `cancel_market` to lifecycle diagram
- Add event to OpenAPI or contract reference
- Note: Cancellation is different from normal settlement (no fees, no pool payout calculation)

---

## 7. Accounting & Trust Model

### 7.1 Fund Flow

```
Participant Wallet
    ↓ [deposit]
    └→ USDC Escrow (contract holds)
       ├─ pool_a (side A deposits)
       ├─ pool_b (side B deposits)
       └─ accrued_fees (from settlement only)

[On resolve] → remaining_escrow = pool_a + pool_b

[On cancel] → For each depositor:
    participant_deposit → push back to wallet
    (no fee deduction, no winner calculation)

[Normal settlement] → For each winner:
    gross = (pool_a + pool_b) * (participant_principal / winner_pool)
    fee = floor(gross - principal) * fee_bps / 10000
    net = gross - fee
    net → push back to wallet
```

### 7.2 Trust Boundaries

| Boundary | Who can cross | Constraints |
|----------|---------------|-------------|
| Create market | Captain | Requires signature |
| Cancel market | Captain | Requires signature, market not resolved |
| Refund funds | Contract | Escrow controls all custody |
| Deposit funds | Participant | Requires signature per amount |

### 7.3 No New Security Surface

- **Authorization**: Existing Soroban `require_auth()` pattern
- **Escrow**: Uses existing `escrow::push()` (proven pattern from claims)
- **Events**: Published after state mutation (best practice)

---

## 8. Acceptance Criteria Verification

| Criterion | Implementation | Verified By |
|-----------|---|---|
| Available through existing interface | `cancel_market` added to contract impl | Callable via generated bindings |
| Doesn't break compatible callers | New function, no signature changes to existing | Regression test suite passes |
| Money movement explicit | Fund flow documented in pool.rs | Code review + test assertions |
| Permissions explicit | `captain.require_auth()` enforced | Auth test case |
| Secrets not leaked | No keys/tokens in events or storage | Code inspection |
| Privacy boundaries respected | Deposits are per-market, not cross-market | Storage design unchanged |
| Types updated | New `AlreadyResolved` error added | Compiles cleanly |
| Migrations documented | None needed | This document |
| Feature flags updated | None needed (always-on feature) | N/A |
| Rollback handling | Safe to remove function | Design review |
| Positive tests | Basic, multi-participant, empty market | Test coverage |
| Negative tests | Auth, state, not found errors | Test coverage |
| Boundary tests | Pre/at deadline, immutability checks | Test coverage |
| Conservation tests | Escrow balance invariant | Test suite |
| Regression tests | Existing operations still work | CI/CD passes |

---

## 9. PR Checklist

- [ ] Code: `cancel_market` implemented in pool.rs
- [ ] Types: `AlreadyResolved` error added
- [ ] Events: `MarketCancelled` published
- [ ] Tests: Full suite in test_cancellation.rs
- [ ] Cargo build: `cargo build --release`
- [ ] Cargo test: `cargo test --release`
- [ ] Lint: No clippy warnings
- [ ] Documentation: Comments on pub fn
- [ ] PR description: Links to this issue, explains accounting + trust model + migration impact

---

## Appendix: Code Locations

| Component | File | Function/Type |
|-----------|------|-------|
| Pool logic | `src/pool.rs` | `cancel_market()` |
| Public interface | `src/contract.rs` | `pub fn cancel_market()` in impl |
| Types | `src/types.rs` | `AlreadyResolved` error |
| Events | `src/events.rs` | `MarketCancelled` struct |
| Tests | `src/test_cancellation.rs` | Full test suite |
| Storage | `src/storage.rs` | No changes (uses existing keys) |
| Escrow | `src/escrow.rs` | No changes (uses existing push) |

---

**Document Status**: Ready for implementation  
**Next Step**: Begin code implementation (task #5)
