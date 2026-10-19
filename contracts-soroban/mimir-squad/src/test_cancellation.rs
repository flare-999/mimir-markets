#![cfg(test)]
//! Market cancellation: captain-initiated refunds before or at deadline.

extern crate std;

use soroban_sdk::testutils::Events as _;
use soroban_sdk::Event;

use crate::test_common::{Fixture, DEFAULT_DURATION, USDC};
use crate::types::{Error, RESULT_CANCELLED, SIDE_A, SIDE_B};

// ── Positive: Basic cancellation ─────────────────────────────────────────────

#[test]
fn captain_can_cancel_a_market_before_any_deposits() {
    let f = Fixture::new();
    let captain = f.user(0);
    let id = f.market(&captain, 250);

    assert_eq!(f.client().get_market(&id).resolved, false);
    assert_eq!(f.client().get_market(&id).result, 0);

    f.client().cancel_market(&id);

    let m = f.client().get_market(&id);
    assert_eq!(m.resolved, true);
    assert_eq!(m.result, RESULT_CANCELLED);
    assert_eq!(m.pool_a, 0);
    assert_eq!(m.pool_b, 0);
}

#[test]
fn captain_can_cancel_a_market_with_deposits_on_one_side() {
    let f = Fixture::new();
    let captain = f.user(0);
    let a1 = f.user(100 * USDC);
    let id = f.market(&captain, 0);

    f.client().deposit(&a1, &id, &SIDE_A, &(30 * USDC));
    assert_eq!(f.token().balance(&a1), 70 * USDC);
    assert_eq!(f.escrow_balance(), 30 * USDC);

    f.client().cancel_market(&id);

    let m = f.client().get_market(&id);
    assert_eq!(m.resolved, true);
    assert_eq!(m.result, RESULT_CANCELLED);
    assert_eq!(m.pool_a, 30 * USDC); // pools unchanged (audit trail)
    assert_eq!(m.pool_b, 0);

    // Participant can now claim their refund
    let refund = f.client().claim(&a1, &id, &SIDE_A);
    assert_eq!(refund, 30 * USDC);
    assert_eq!(f.token().balance(&a1), 100 * USDC); // full refund, no fee
    assert_eq!(f.escrow_balance(), 0);
}

#[test]
fn captain_can_cancel_a_market_with_deposits_on_both_sides() {
    let f = Fixture::new();
    let captain = f.user(0);
    let a1 = f.user(100 * USDC);
    let b1 = f.user(100 * USDC);
    let id = f.market(&captain, 0);

    f.client().deposit(&a1, &id, &SIDE_A, &(20 * USDC));
    f.client().deposit(&b1, &id, &SIDE_B, &(30 * USDC));
    assert_eq!(f.escrow_balance(), 50 * USDC);

    f.client().cancel_market(&id);

    let m = f.client().get_market(&id);
    assert_eq!(m.resolved, true);
    assert_eq!(m.result, RESULT_CANCELLED);

    // Both sides can claim refunds
    let refund_a = f.client().claim(&a1, &id, &SIDE_A);
    assert_eq!(refund_a, 20 * USDC);
    assert_eq!(f.token().balance(&a1), 100 * USDC);

    let refund_b = f.client().claim(&b1, &id, &SIDE_B);
    assert_eq!(refund_b, 30 * USDC);
    assert_eq!(f.token().balance(&b1), 100 * USDC);

    assert_eq!(f.escrow_balance(), 0);
}

#[test]
fn multiple_participants_on_the_same_side_can_each_claim_their_refund() {
    let f = Fixture::new();
    let captain = f.user(0);
    let a1 = f.user(100 * USDC);
    let a2 = f.user(100 * USDC);
    let a3 = f.user(100 * USDC);
    let id = f.market(&captain, 0);

    f.client().deposit(&a1, &id, &SIDE_A, &(10 * USDC));
    f.client().deposit(&a2, &id, &SIDE_A, &(15 * USDC));
    f.client().deposit(&a3, &id, &SIDE_A, &(25 * USDC));
    assert_eq!(f.escrow_balance(), 50 * USDC);

    f.client().cancel_market(&id);

    // All three can claim their exact refunds
    assert_eq!(f.client().claim(&a1, &id, &SIDE_A), 10 * USDC);
    assert_eq!(f.client().claim(&a2, &id, &SIDE_A), 15 * USDC);
    assert_eq!(f.client().claim(&a3, &id, &SIDE_A), 25 * USDC);

    assert_eq!(f.token().balance(&a1), 100 * USDC);
    assert_eq!(f.token().balance(&a2), 100 * USDC);
    assert_eq!(f.token().balance(&a3), 100 * USDC);
    assert_eq!(f.escrow_balance(), 0);
}

#[test]
fn a_participant_who_topped_up_multiple_times_gets_total_refunded() {
    let f = Fixture::new();
    let captain = f.user(0);
    let a1 = f.user(100 * USDC);
    let id = f.market(&captain, 0);

    // Top up in two deposits
    f.client().deposit(&a1, &id, &SIDE_A, &(7 * USDC));
    f.client().deposit(&a1, &id, &SIDE_A, &(13 * USDC));
    assert_eq!(f.client().get_deposit(&id, &SIDE_A, &a1), 20 * USDC);
    assert_eq!(f.escrow_balance(), 20 * USDC);

    f.client().cancel_market(&id);

    // Full total is refunded
    let refund = f.client().claim(&a1, &id, &SIDE_A);
    assert_eq!(refund, 20 * USDC);
    assert_eq!(f.token().balance(&a1), 100 * USDC);
}

#[test]
fn a_participant_on_both_sides_can_claim_from_both() {
    let f = Fixture::new();
    let captain = f.user(0);
    let both = f.user(100 * USDC);
    let id = f.market(&captain, 0);

    f.client().deposit(&both, &id, &SIDE_A, &(12 * USDC));
    f.client().deposit(&both, &id, &SIDE_B, &(18 * USDC));
    assert_eq!(f.escrow_balance(), 30 * USDC);

    f.client().cancel_market(&id);

    // Claim from side A
    let refund_a = f.client().claim(&both, &id, &SIDE_A);
    assert_eq!(refund_a, 12 * USDC);

    // Claim from side B
    let refund_b = f.client().claim(&both, &id, &SIDE_B);
    assert_eq!(refund_b, 18 * USDC);

    assert_eq!(f.token().balance(&both), 100 * USDC);
    assert_eq!(f.escrow_balance(), 0);
}

#[test]
fn cancellation_publishes_the_correct_event() {
    let f = Fixture::new();
    let captain = f.user(0);
    let a1 = f.user(100 * USDC);
    let id = f.market(&captain, 0);

    f.client().deposit(&a1, &id, &SIDE_A, &(25 * USDC));
    f.client().cancel_market(&id);

    let expected = crate::events::MarketCancelled {
        market_id: id,
        captain: captain.clone(),
        pool_a: 25 * USDC,
        pool_b: 0,
    }
    .to_xdr(&f.env, &f.contract_id);
    let emitted = f.env.events().all();
    assert!(emitted.events().iter().any(|e| e == &expected));
}

// ── Negative: Authorization & state ──────────────────────────────────────────

#[test]
fn only_the_captain_can_cancel_a_market() {
    let f = Fixture::new();
    let captain = f.user(0);
    let id = f.market(&captain, 0);

    f.env.set_auths(&[]);
    // Soroban auth failure — captain didn't sign.
    assert!(f.client().try_cancel_market(&id).is_err());
    assert!(!f.client().get_market(&id).resolved);
}

#[test]
fn cancelling_an_already_resolved_market_fails() {
    let f = Fixture::new();
    let captain = f.user(0);
    let a1 = f.user(100 * USDC);
    let b1 = f.user(100 * USDC);
    let id = f.market(&captain, 0);

    f.client().deposit(&a1, &id, &SIDE_A, &(10 * USDC));
    f.client().deposit(&b1, &id, &SIDE_B, &(10 * USDC));

    // Advance past deadline and resolve
    f.advance_by(DEFAULT_DURATION);
    f.client().resolve(&id, &SIDE_A);

    // Try to cancel — should fail
    let err = f
        .client()
        .try_cancel_market(&id)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::AlreadyResolved);
}

#[test]
fn cancelling_an_unknown_market_fails() {
    let f = Fixture::new();
    let err = f
        .client()
        .try_cancel_market(&9999)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::MarketNotFound);
}

#[test]
fn cancelling_the_same_market_twice_fails_on_the_second_call() {
    let f = Fixture::new();
    let captain = f.user(0);
    let id = f.market(&captain, 0);

    f.client().cancel_market(&id);
    assert_eq!(f.client().get_market(&id).resolved, true);

    // Try to cancel again
    let err = f
        .client()
        .try_cancel_market(&id)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::AlreadyResolved);
}

// ── Edge cases ───────────────────────────────────────────────────────────────

#[test]
fn a_participant_who_already_claimed_from_a_cancelled_market_gets_zero_on_retry() {
    let f = Fixture::new();
    let captain = f.user(0);
    let a1 = f.user(100 * USDC);
    let id = f.market(&captain, 0);

    f.client().deposit(&a1, &id, &SIDE_A, &(20 * USDC));
    f.client().cancel_market(&id);

    // Claim once
    let first = f.client().claim(&a1, &id, &SIDE_A);
    assert_eq!(first, 20 * USDC);

    // Claim again — already claimed, returns 0
    let second = f.client().claim(&a1, &id, &SIDE_A);
    assert_eq!(second, 0);

    assert_eq!(f.token().balance(&a1), 100 * USDC);
}

#[test]
fn a_participant_with_no_deposit_cannot_claim_from_a_cancelled_market() {
    let f = Fixture::new();
    let captain = f.user(0);
    let a1 = f.user(100 * USDC);
    let nobody = f.user(100 * USDC);
    let id = f.market(&captain, 0);

    f.client().deposit(&a1, &id, &SIDE_A, &(10 * USDC));
    f.client().cancel_market(&id);

    // Someone with no deposit tries to claim
    let err = f
        .client()
        .try_claim(&nobody, &id, &SIDE_A)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::NotWinner); // No deposit on that side

    assert_eq!(f.token().balance(&nobody), 100 * USDC);
}

#[test]
fn cancellation_is_rejected_at_the_deadline_timestamp() {
    let f = Fixture::new();
    let captain = f.user(0);
    let a1 = f.user(100 * USDC);
    let id = f.market(&captain, 0);

    f.client().deposit(&a1, &id, &SIDE_A, &(10 * USDC));

    // Advance exactly to the deadline: the outcome may now be known.
    f.advance_by(DEFAULT_DURATION);

    let err = f.client().try_cancel_market(&id).unwrap_err().unwrap();
    assert_eq!(err, Error::MarketClosed);
    assert!(!f.client().get_market(&id).resolved);
}

#[test]
fn a_captain_depositor_cannot_cancel_a_losing_market_after_the_deadline() {
    let f = Fixture::new();
    let captain = f.user(100 * USDC);
    let b1 = f.user(100 * USDC);
    let id = f.market(&captain, 0);

    f.client().deposit(&captain, &id, &SIDE_A, &(40 * USDC));
    f.client().deposit(&b1, &id, &SIDE_B, &(40 * USDC));
    f.advance_by(DEFAULT_DURATION + 3_600);

    let err = f.client().try_cancel_market(&id).unwrap_err().unwrap();
    assert_eq!(err, Error::MarketClosed);

    // Settlement still runs normally and pays the winner.
    f.client().resolve(&id, &SIDE_B);
    assert_eq!(f.client().claim(&b1, &id, &SIDE_B), 80 * USDC);
    assert_eq!(f.escrow_balance(), 0);
}

#[test]
fn cancel_seeds_remaining_escrow_with_both_pools() {
    let f = Fixture::new();
    let captain = f.user(0);
    let a1 = f.user(100 * USDC);
    let b1 = f.user(100 * USDC);
    let id = f.market(&captain, 0);

    f.client().deposit(&a1, &id, &SIDE_A, &(20 * USDC));
    f.client().deposit(&b1, &id, &SIDE_B, &(30 * USDC));
    f.client().cancel_market(&id);
    assert_eq!(f.client().get_market(&id).remaining_escrow, 50 * USDC);

    f.client().claim(&a1, &id, &SIDE_A);
    assert_eq!(f.client().get_market(&id).remaining_escrow, 30 * USDC);
    f.client().claim(&b1, &id, &SIDE_B);
    assert_eq!(f.client().get_market(&id).remaining_escrow, 0);
    assert_eq!(f.escrow_balance(), 0);
}

#[test]
fn cancellation_does_not_accrue_fees() {
    let f = Fixture::new();
    let captain = f.user(0);
    let a1 = f.user(100 * USDC);
    let b1 = f.user(100 * USDC);
    let id = f.market(&captain, 500); // 5% fee on profit

    f.client().deposit(&a1, &id, &SIDE_A, &(50 * USDC));
    f.client().deposit(&b1, &id, &SIDE_B, &(50 * USDC));

    let fees_before = f.client().get_accrued_fees();
    f.client().cancel_market(&id);
    let fees_after = f.client().get_accrued_fees();

    // No fees accrued
    assert_eq!(fees_before, fees_after);
    assert_eq!(fees_after, 0);

    // Participants get full refunds with no fee deduction
    let refund_a = f.client().claim(&a1, &id, &SIDE_A);
    assert_eq!(refund_a, 50 * USDC);

    let refund_b = f.client().claim(&b1, &id, &SIDE_B);
    assert_eq!(refund_b, 50 * USDC);
}

// ── Invariants ───────────────────────────────────────────────────────────────

#[test]
fn escrow_balance_is_conserved_through_cancellation_and_claims() {
    let f = Fixture::new();
    let captain = f.user(0);
    let a1 = f.user(100 * USDC);
    let a2 = f.user(100 * USDC);
    let b1 = f.user(100 * USDC);
    let id = f.market(&captain, 0);

    f.client().deposit(&a1, &id, &SIDE_A, &(25 * USDC));
    f.client().deposit(&a2, &id, &SIDE_A, &(15 * USDC));
    f.client().deposit(&b1, &id, &SIDE_B, &(40 * USDC));

    let escrow_after_deposits = f.escrow_balance();
    assert_eq!(escrow_after_deposits, 80 * USDC);

    f.client().cancel_market(&id);

    let escrow_after_cancel = f.escrow_balance();
    assert_eq!(escrow_after_cancel, 80 * USDC); // unchanged after cancel

    // Claim all refunds
    f.client().claim(&a1, &id, &SIDE_A);
    f.client().claim(&a2, &id, &SIDE_A);
    f.client().claim(&b1, &id, &SIDE_B);

    let escrow_final = f.escrow_balance();
    assert_eq!(escrow_final, 0); // all refunded

    // Participants got back exactly what they put in
    assert_eq!(f.token().balance(&a1), 100 * USDC);
    assert_eq!(f.token().balance(&a2), 100 * USDC);
    assert_eq!(f.token().balance(&b1), 100 * USDC);
}

#[test]
fn pools_remain_unchanged_after_cancellation() {
    let f = Fixture::new();
    let captain = f.user(0);
    let a1 = f.user(100 * USDC);
    let b1 = f.user(100 * USDC);
    let id = f.market(&captain, 0);

    f.client().deposit(&a1, &id, &SIDE_A, &(33 * USDC));
    f.client().deposit(&b1, &id, &SIDE_B, &(77 * USDC));

    let m_before = f.client().get_market(&id);
    assert_eq!(m_before.pool_a, 33 * USDC);
    assert_eq!(m_before.pool_b, 77 * USDC);

    f.client().cancel_market(&id);

    let m_after = f.client().get_market(&id);
    // Pools unchanged (audit trail)
    assert_eq!(m_after.pool_a, 33 * USDC);
    assert_eq!(m_after.pool_b, 77 * USDC);
    assert_eq!(m_after.resolved, true);
    assert_eq!(m_after.result, RESULT_CANCELLED);
}
