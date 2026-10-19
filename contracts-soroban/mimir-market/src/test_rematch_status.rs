#![cfg(test)]
//! `RematchStatus` round-trips through the rematch parent-link cache.

extern crate std;

use crate::storage;
use crate::test_common::Fixture;
use crate::types::RematchStatus;

const ALL: [RematchStatus; 4] = [
    RematchStatus::Linked,
    RematchStatus::ParentNotFound,
    RematchStatus::ParentInvalidState,
    RematchStatus::ParentAlreadyRematched,
];

#[test]
fn every_variant_round_trips_through_storage() {
    let f = Fixture::new(0, 0);
    f.env.as_contract(&f.contract_id, || {
        for (i, status) in ALL.iter().enumerate() {
            let child = 100 + i as u64;
            storage::set_rematch_parent_status(&f.env, 1, child, status);
            assert_eq!(
                storage::get_rematch_parent_status(&f.env, 1, child),
                Some(*status)
            );
        }
    });
}

#[test]
fn missing_link_reads_as_none_and_clear_removes_it() {
    let f = Fixture::new(0, 0);
    f.env.as_contract(&f.contract_id, || {
        assert_eq!(storage::get_rematch_parent_status(&f.env, 7, 8), None);
        storage::set_rematch_parent_status(&f.env, 7, 8, &RematchStatus::Linked);
        storage::clear_rematch_parent_status(&f.env, 7, 8);
        assert_eq!(storage::get_rematch_parent_status(&f.env, 7, 8), None);
    });
}

#[test]
fn links_are_keyed_by_parent_and_child() {
    let f = Fixture::new(0, 0);
    f.env.as_contract(&f.contract_id, || {
        storage::set_rematch_parent_status(&f.env, 1, 2, &RematchStatus::Linked);
        storage::set_rematch_parent_status(&f.env, 2, 1, &RematchStatus::ParentInvalidState);
        assert_eq!(
            storage::get_rematch_parent_status(&f.env, 1, 2),
            Some(RematchStatus::Linked)
        );
        assert_eq!(
            storage::get_rematch_parent_status(&f.env, 2, 1),
            Some(RematchStatus::ParentInvalidState)
        );
    });
}
