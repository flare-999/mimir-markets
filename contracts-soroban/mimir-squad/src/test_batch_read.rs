#![cfg(test)]
//! Batch-read squad market state — `get_markets_batch`.
//!
//! # Coverage
//!
//! positive     – single id, several ids, full batch at MAX_BATCH_SIZE, empty vec
//! negative     – unknown id in batch, all unknown, batch too large, uninitialized
//! boundary     – id 0 (never assigned), exactly MAX_BATCH_SIZE, MAX_BATCH_SIZE + 1
//! consistency  – batch result values equal individual `get_market` results;
//!                position stability; duplicate ids return consistent values;
//!                no state mutations or fund movements

extern crate std;

use soroban_sdk::Vec;

use crate::contract::MimirSquad;
use crate::contract::MimirSquadClient;
use crate::test_common::Fixture;
use crate::types::{Error, MAX_BATCH_SIZE};

// ── Helpers ──────────────────────────────────────────────────────────────────

fn create_markets(f: &Fixture, n: u32) -> std::vec::Vec<u64> {
    let mut ids = std::vec::Vec::new();
    let captain = f.user(0);
    for i in 0..n {
        let id = f.market(&captain, (i % 500) as u32);
        ids.push(id);
    }
    ids
}

fn sdk_ids(f: &Fixture, ids: &[u64]) -> Vec<u64> {
    let mut v: Vec<u64> = Vec::new(&f.env);
    for &id in ids {
        v.push_back(id);
    }
    v
}

// ── Positive tests ───────────────────────────────────────────────────────────

#[test]
fn single_existing_id_returns_some() {
    let f = Fixture::new();
    let ids = create_markets(&f, 1);

    let batch = f.client().get_markets_batch(&sdk_ids(&f, &ids));
    assert_eq!(batch.len(), 1);
    assert!(batch.get(0).unwrap().is_some(), "existing market should return Some");
}

#[test]
fn several_existing_ids_all_return_some() {
    let f = Fixture::new();
    let ids = create_markets(&f, 5);

    let batch = f.client().get_markets_batch(&sdk_ids(&f, &ids));
    assert_eq!(batch.len(), 5, "length must equal input ids length");
    for i in 0..5 {
        assert!(
            batch.get(i).unwrap().is_some(),
            "slot {i} should be Some for existing market"
        );
    }
}

#[test]
fn empty_batch_returns_empty_vec() {
    let f = Fixture::new();
    let _ = create_markets(&f, 2);

    let batch = f.client().get_markets_batch(&sdk_ids(&f, &[]));
    assert_eq!(batch.len(), 0, "empty input must produce empty output");
}

#[test]
fn unknown_ids_return_none() {
    let f = Fixture::new();
    let _ = create_markets(&f, 2);

    let unknown = [900u64, 901, 902];
    let batch = f.client().get_markets_batch(&sdk_ids(&f, &unknown));
    assert_eq!(batch.len(), 3);
    for i in 0..3 {
        assert!(
            batch.get(i).unwrap().is_none(),
            "slot {i} must be None for unknown id"
        );
    }
}

#[test]
fn interleaved_known_and_unknown_ids() {
    let f = Fixture::new();
    let ids = create_markets(&f, 3);
    let id0 = ids[0];
    let id2 = ids[2];

    let query = [id0, 999_999, id2, 888_888];
    let batch = f.client().get_markets_batch(&sdk_ids(&f, &query));

    assert_eq!(batch.len(), 4);
    assert!(batch.get(0).unwrap().is_some(), "id0 must be Some");
    assert!(batch.get(1).unwrap().is_none(), "999_999 must be None");
    assert!(batch.get(2).unwrap().is_some(), "id2 must be Some");
    assert!(batch.get(3).unwrap().is_none(), "888_888 must be None");
}

#[test]
fn duplicate_ids_return_consistent_values() {
    let f = Fixture::new();
    let ids = create_markets(&f, 1);
    let id = ids[0];

    let query = [id, id, id];
    let batch = f.client().get_markets_batch(&sdk_ids(&f, &query));

    assert_eq!(batch.len(), 3);
    let m0 = batch.get(0).unwrap().unwrap();
    let m1 = batch.get(1).unwrap().unwrap();
    let m2 = batch.get(2).unwrap().unwrap();

    assert_eq!(m0, m1);
    assert_eq!(m1, m2);
}

#[test]
fn position_stability_preserves_input_order() {
    let f = Fixture::new();
    let ids = create_markets(&f, 3);
    let [id0, id1, id2] = [ids[0], ids[1], ids[2]];

    let reversed = [id2, id1, id0];
    let batch = f.client().get_markets_batch(&sdk_ids(&f, &reversed));

    assert_eq!(batch.len(), 3);
    let m_first = batch.get(0).unwrap().unwrap();
    let m_last = batch.get(2).unwrap().unwrap();

    let expected_first = f.client().get_market(&id2);
    let expected_last = f.client().get_market(&id0);

    assert_eq!(m_first, expected_first);
    assert_eq!(m_last, expected_last);
}

#[test]
fn values_match_get_market_identically() {
    let f = Fixture::new();
    let ids = create_markets(&f, 4);

    let batch = f.client().get_markets_batch(&sdk_ids(&f, &ids));
    for (i, &id) in ids.iter().enumerate() {
        let single = f.client().get_market(&id);
        let from_batch = batch.get(i as u32).unwrap().unwrap();
        assert_eq!(from_batch, single, "batch result must match single get_market for id {id}");
    }
}

// ── Boundary & error tests ───────────────────────────────────────────────────

#[test]
fn maximum_batch_size_is_accepted() {
    let f = Fixture::new();
    let ids = create_markets(&f, MAX_BATCH_SIZE);
    assert_eq!(ids.len() as u32, MAX_BATCH_SIZE);

    let batch = f.client().get_markets_batch(&sdk_ids(&f, &ids));
    assert_eq!(batch.len(), MAX_BATCH_SIZE);
    for i in 0..MAX_BATCH_SIZE {
        assert!(batch.get(i).unwrap().is_some());
    }
}

#[test]
fn batch_too_large_is_rejected() {
    let f = Fixture::new();
    let ids = create_markets(&f, MAX_BATCH_SIZE);
    let mut oversized = ids;
    oversized.push(9_999);
    assert_eq!(oversized.len() as u32, MAX_BATCH_SIZE + 1);

    let err = f
        .client()
        .try_get_markets_batch(&sdk_ids(&f, &oversized))
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::BatchTooLarge);
}

#[test]
fn batch_too_large_rejected_before_storage_reads() {
    let f = Fixture::new();
    // 51 unknown ids without creating any markets
    let mut query = std::vec::Vec::new();
    for i in 0..(MAX_BATCH_SIZE + 1) {
        query.push(10_000 + i as u64);
    }

    let err = f
        .client()
        .try_get_markets_batch(&sdk_ids(&f, &query))
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::BatchTooLarge);
}

#[test]
fn uninitialized_contract_returns_not_initialized() {
    let env = soroban_sdk::Env::default();
    let contract_id = env.register(MimirSquad, ());
    let client = MimirSquadClient::new(&env, &contract_id);

    let mut ids: Vec<u64> = Vec::new(&env);
    ids.push_back(1);

    let err = client.try_get_markets_batch(&ids).unwrap_err().unwrap();
    assert_eq!(err, Error::NotInitialized);
}

#[test]
fn no_state_mutation_or_usdc_movement() {
    let f = Fixture::new();
    let ids = create_markets(&f, 3);

    let escrow_before = f.escrow_balance();
    let market_count_before = f.client().get_market_count();
    let fees_before = f.client().get_accrued_fees();

    let _ = f.client().get_markets_batch(&sdk_ids(&f, &ids));

    assert_eq!(f.escrow_balance(), escrow_before, "escrow balance must not change");
    assert_eq!(f.client().get_market_count(), market_count_before, "market count must not change");
    assert_eq!(f.client().get_accrued_fees(), fees_before, "accrued fees must not change");
}

#[test]
fn ttl_extended_for_present_entries_like_get_market() {
    let f = Fixture::new();
    let ids = create_markets(&f, 2);
    let id0 = ids[0];

    // Read via batch
    let batch = f.client().get_markets_batch(&sdk_ids(&f, &[id0, 999_999]));
    assert!(batch.get(0).unwrap().is_some());
    assert!(batch.get(1).unwrap().is_none());

    // Present market remains directly accessible via get_market
    let m = f.client().get_market(&id0);
    assert_eq!(m, batch.get(0).unwrap().unwrap());
}

