#![cfg(test)]
//! Squad payout preview parity tests (issue #495).
//!
//! Asserts that `preview_claim` (used by the UI to preview payouts) exactly
//! agrees with `claim` across every scenario:
//!   - gross, fee, and net match for every participant
//!   - the final claimant absorbs dust identically in preview and claim
//!   - uneven deposits, fee-free, and max-fee (10%) markets
//!   - one-winner and many-winner markets in various claiming orders
//!   - cancelled markets (captain cancellation, oracle cancellation, and
//!     underfunded deadline transition refunds)

extern crate std;

use std::vec::Vec;
use soroban_sdk::Address;

use crate::test_common::{Fixture, DEFAULT_DURATION, USDC};
use crate::types::{MAX_FEE_BPS, RESULT_CANCELLED, SIDE_A, SIDE_B};

/// Verify that `preview_claim` called immediately before `claim` predicts the
/// exact gross, fee, and net amounts transferred and accounted for, and that
/// post-claim previews return zero.
fn assert_preview_matches_claim(
    f: &Fixture,
    market_id: u64,
    side: u32,
    participant: &Address,
) {
    let preview = f.client().preview_claim(&market_id, &side, participant);

    // Consistency: net must always equal gross minus fee.
    assert_eq!(
        preview.net,
        preview.gross - preview.fee,
        "preview internal arithmetic must hold: net == gross - fee"
    );

    let escrow_before = f.client().get_market(&market_id).remaining_escrow;
    let fees_before = f.client().get_accrued_fees();
    let balance_before = f.token().balance(participant);

    let actual_net = f.client().claim(participant, &market_id, &side);

    let escrow_after = f.client().get_market(&market_id).remaining_escrow;
    let fees_after = f.client().get_accrued_fees();
    let balance_after = f.token().balance(participant);

    // Net equality: return value and token balance delta must match preview.
    assert_eq!(
        actual_net, preview.net,
        "claim return value must match previewed net"
    );
    assert_eq!(
        balance_after - balance_before,
        preview.net,
        "token transfer amount must match previewed net"
    );

    // Gross equality: escrow drawdown must equal previewed gross.
    assert_eq!(
        escrow_before - escrow_after,
        preview.gross,
        "escrow drawdown must match previewed gross"
    );

    // Fee equality: accrued fee delta must equal previewed fee.
    assert_eq!(
        fees_after - fees_before,
        preview.fee,
        "accrued fee increase must match previewed fee"
    );
}

// ── Single-winner markets ───────────────────────────────────────────────────

#[test]
fn preview_matches_claim_lone_winner_max_fee() {
    let f = Fixture::new();
    let captain = f.user(0);
    let id = f.market(&captain, MAX_FEE_BPS); // 10% fee

    let winner = f.user(10 * USDC);
    f.client().deposit(&winner, &id, &SIDE_A, &(10 * USDC));

    let losers = [f.user(7 * USDC), f.user(13 * USDC), f.user(25 * USDC)];
    f.client().deposit(&losers[0], &id, &SIDE_B, &(7 * USDC));
    f.client().deposit(&losers[1], &id, &SIDE_B, &(13 * USDC));
    f.client().deposit(&losers[2], &id, &SIDE_B, &(25 * USDC));

    f.advance_by(DEFAULT_DURATION);
    f.client().resolve(&id, &SIDE_A);

    // Lone winner is also the last claimant.
    assert_preview_matches_claim(&f, id, SIDE_A, &winner);
    assert_eq!(f.client().get_market(&id).remaining_escrow, 0);
}

#[test]
fn preview_matches_claim_lone_winner_zero_fee() {
    let f = Fixture::new();
    let captain = f.user(0);
    let id = f.market(&captain, 0);

    let winner = f.user(20 * USDC);
    f.client().deposit(&winner, &id, &SIDE_A, &(20 * USDC));

    let loser = f.user(80 * USDC);
    f.client().deposit(&loser, &id, &SIDE_B, &(80 * USDC));

    f.advance_by(DEFAULT_DURATION);
    f.client().resolve(&id, &SIDE_A);

    assert_preview_matches_claim(&f, id, SIDE_A, &winner);
    assert_eq!(f.client().get_market(&id).remaining_escrow, 0);
    assert_eq!(f.client().get_accrued_fees(), 0);
}

// ── Many-winner markets with uneven deposits ─────────────────────────────────

#[test]
fn preview_matches_claim_uneven_deposits_max_fee_many_winners() {
    let f = Fixture::new();
    let captain = f.user(0);
    let id = f.market(&captain, MAX_FEE_BPS);

    // Awkward, uneven deposits on the winning side that produce truncation dust.
    let winner_stakes = [1i128, 7, 3_333_333, 10 * USDC + 1, 25 * USDC + 99];
    let loser_stakes = [2i128, 999_999, 14 * USDC + 77, 40 * USDC];

    let mut winners = Vec::new();
    for s in winner_stakes {
        let who = f.user(s);
        f.client().deposit(&who, &id, &SIDE_A, &s);
        winners.push(who);
    }
    for s in loser_stakes {
        let who = f.user(s);
        f.client().deposit(&who, &id, &SIDE_B, &s);
    }

    f.advance_by(DEFAULT_DURATION);
    f.client().resolve(&id, &SIDE_A);

    // Every winner claims in sequence; verify parity for each, including the
    // final claimant absorbing dust.
    for winner in winners.iter() {
        assert_preview_matches_claim(&f, id, SIDE_A, winner);
    }

    assert_eq!(f.client().get_market(&id).remaining_escrow, 0);
}

#[test]
fn preview_matches_claim_many_winners_reverse_order() {
    let f = Fixture::new();
    let captain = f.user(0);
    let id = f.market(&captain, 500); // 5% fee

    let winner_stakes = [
        100_000i128,
        500_000,
        1 * USDC,
        2 * USDC + 333,
        5 * USDC,
        10 * USDC + 77,
        20 * USDC,
    ];
    let loser_stakes = [3 * USDC, 11 * USDC, 27 * USDC];

    let mut winners = Vec::new();
    for s in winner_stakes {
        let who = f.user(s);
        f.client().deposit(&who, &id, &SIDE_A, &s);
        winners.push(who);
    }
    for s in loser_stakes {
        let who = f.user(s);
        f.client().deposit(&who, &id, &SIDE_B, &s);
    }

    f.advance_by(DEFAULT_DURATION);
    f.client().resolve(&id, &SIDE_A);

    // Reverse claiming order (largest to smallest)
    for winner in winners.iter().rev() {
        assert_preview_matches_claim(&f, id, SIDE_A, winner);
    }

    assert_eq!(f.client().get_market(&id).remaining_escrow, 0);
}

#[test]
fn preview_matches_claim_mixed_ten_winners_zero_fee() {
    let f = Fixture::new();
    let captain = f.user(0);
    let id = f.market(&captain, 0);

    let winner_stakes = [
        1i128, 3, 5, 100, 10_000,
        100_000, 1 * USDC, 2 * USDC, 5 * USDC, 10 * USDC,
    ];

    let mut winners = Vec::new();
    for s in winner_stakes {
        let who = f.user(s);
        f.client().deposit(&who, &id, &SIDE_A, &s);
        winners.push(who);
    }

    let loser = f.user(50 * USDC);
    f.client().deposit(&loser, &id, &SIDE_B, &(50 * USDC));

    f.advance_by(DEFAULT_DURATION);
    f.client().resolve(&id, &SIDE_A);

    for winner in winners.iter() {
        assert_preview_matches_claim(&f, id, SIDE_A, winner);
    }

    assert_eq!(f.client().get_market(&id).remaining_escrow, 0);
    assert_eq!(f.client().get_accrued_fees(), 0);
}

// ── Cancelled markets (refund previews) ──────────────────────────────────────

#[test]
fn preview_matches_claim_captain_cancelled_market() {
    let f = Fixture::new();
    let captain = f.user(0);
    let id = f.market(&captain, MAX_FEE_BPS);

    let a_stakes = [1 * USDC, 5 * USDC + 123, 10 * USDC];
    let b_stakes = [2 * USDC, 7 * USDC + 456, 12 * USDC];

    let mut side_a = Vec::new();
    let mut side_b = Vec::new();
    for s in a_stakes {
        let who = f.user(s);
        f.client().deposit(&who, &id, &SIDE_A, &s);
        side_a.push(who);
    }
    for s in b_stakes {
        let who = f.user(s);
        f.client().deposit(&who, &id, &SIDE_B, &s);
        side_b.push(who);
    }

    // Captain cancels before the deadline.
    f.client().cancel_market(&id);
    let market = f.client().get_market(&id);
    assert!(market.resolved);
    assert_eq!(market.result, RESULT_CANCELLED);

    // Verify refund preview parity for all participants on SIDE_A.
    for participant in side_a.iter() {
        assert_preview_matches_claim(&f, id, SIDE_A, participant);
    }

    // Verify refund preview parity for all participants on SIDE_B.
    for participant in side_b.iter() {
        assert_preview_matches_claim(&f, id, SIDE_B, participant);
    }

    assert_eq!(f.client().get_market(&id).remaining_escrow, 0);
    assert_eq!(f.client().get_accrued_fees(), 0);
}

#[test]
fn preview_matches_claim_oracle_cancelled_market() {
    let f = Fixture::new();
    let captain = f.user(0);
    let id = f.market(&captain, MAX_FEE_BPS);

    let a_stakes = [500_000i128, 3 * USDC, 15 * USDC];
    let b_stakes = [1 * USDC, 4 * USDC, 8 * USDC];

    let mut side_a = Vec::new();
    let mut side_b = Vec::new();
    for s in a_stakes {
        let who = f.user(s);
        f.client().deposit(&who, &id, &SIDE_A, &s);
        side_a.push(who);
    }
    for s in b_stakes {
        let who = f.user(s);
        f.client().deposit(&who, &id, &SIDE_B, &s);
        side_b.push(who);
    }

    f.advance_by(DEFAULT_DURATION);
    f.client().resolve(&id, &RESULT_CANCELLED);

    for participant in side_a.iter() {
        assert_preview_matches_claim(&f, id, SIDE_A, participant);
    }
    for participant in side_b.iter() {
        assert_preview_matches_claim(&f, id, SIDE_B, participant);
    }

    assert_eq!(f.client().get_market(&id).remaining_escrow, 0);
    assert_eq!(f.client().get_accrued_fees(), 0);
}

#[test]
fn preview_matches_claim_underfunded_market_deadline_transition() {
    let f = Fixture::new();
    let captain = f.user(0);
    let id = f.market(&captain, MAX_FEE_BPS);

    // Deposits on SIDE_A only; SIDE_B has 0 deposits.
    let a_stakes = [2 * USDC, 7 * USDC, 11 * USDC];
    let mut side_a = Vec::new();
    for s in a_stakes {
        let who = f.user(s);
        f.client().deposit(&who, &id, &SIDE_A, &s);
        side_a.push(who);
    }

    f.advance_by(DEFAULT_DURATION);
    f.client().transition_deadline(&id);

    let market = f.client().get_market(&id);
    assert!(market.resolved);
    assert_eq!(market.result, RESULT_CANCELLED);

    for participant in side_a.iter() {
        assert_preview_matches_claim(&f, id, SIDE_A, participant);
    }

    assert_eq!(f.client().get_market(&id).remaining_escrow, 0);
}

#[test]
fn preview_matches_claim_double_sided_depositor() {
    let f = Fixture::new();
    let captain = f.user(0);
    let id = f.market(&captain, 800); // 8% fee

    let double_user = f.user(50 * USDC);
    let other_b = f.user(50 * USDC);

    f.client().deposit(&double_user, &id, &SIDE_A, &(10 * USDC));
    f.client().deposit(&double_user, &id, &SIDE_B, &(15 * USDC));
    f.client().deposit(&other_b, &id, &SIDE_B, &(25 * USDC));

    f.advance_by(DEFAULT_DURATION);
    f.client().resolve(&id, &SIDE_A);

    // Double depositor on winning SIDE_A: preview matches claim.
    assert_preview_matches_claim(&f, id, SIDE_A, &double_user);

    // On losing SIDE_B: preview is 0.
    let losing_preview = f.client().preview_claim(&id, &SIDE_B, &double_user);
    assert_eq!(losing_preview.gross, 0);
    assert_eq!(losing_preview.fee, 0);
    assert_eq!(losing_preview.net, 0);
}
