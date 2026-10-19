#![cfg(test)]
//! Oracle rotation timelock: queue, cancel, execute, auth, and failure paths.

extern crate std;

use soroban_sdk::testutils::Address as _;
use soroban_sdk::Address;

use crate::test_common::Fixture;
use crate::types::{Error, ORACLE_TIMELOCK_SECONDS};

#[test]
fn oracle_rotation_is_oracle_gated_and_timelocked() {
    let f = Fixture::new();
    let new_oracle = Address::generate(&f.env);
    let previous = f.client().get_oracle();

    f.env.set_auths(&[]);
    assert!(f.client().try_queue_oracle(&new_oracle).is_err());

    f.env.mock_all_auths();
    f.client().queue_oracle(&new_oracle);
    let queued = f.client().get_pending_oracle().unwrap();
    assert_eq!(queued.next, new_oracle);
    assert_eq!(
        queued.executable_at,
        f.env.ledger().timestamp() + ORACLE_TIMELOCK_SECONDS
    );
    assert_eq!(f.client().get_oracle(), previous);

    let err = f.client().try_execute_oracle().unwrap_err().unwrap();
    assert_eq!(err, Error::Timelocked);

    f.advance_by(ORACLE_TIMELOCK_SECONDS);
    f.client().execute_oracle();
    assert_eq!(f.client().get_oracle(), new_oracle);
    assert!(f.client().get_pending_oracle().is_none());
}

#[test]
fn oracle_rotation_execution_is_permissionless_after_timelock() {
    let f = Fixture::new();
    let new_oracle = Address::generate(&f.env);

    f.client().queue_oracle(&new_oracle);
    f.advance_by(ORACLE_TIMELOCK_SECONDS);

    f.env.set_auths(&[]);
    f.client().execute_oracle();
    assert_eq!(f.client().get_oracle(), new_oracle);
}

#[test]
fn cancelling_oracle_rotation_clears_the_queue() {
    let f = Fixture::new();
    let new_oracle = Address::generate(&f.env);

    let err = f.client().try_cancel_oracle().unwrap_err().unwrap();
    assert_eq!(err, Error::NothingQueued);

    f.client().queue_oracle(&new_oracle);
    f.client().cancel_oracle();
    assert!(f.client().get_pending_oracle().is_none());
    assert_eq!(f.client().get_oracle(), f.oracle);

    f.advance_by(ORACLE_TIMELOCK_SECONDS * 2);
    let err = f.client().try_execute_oracle().unwrap_err().unwrap();
    assert_eq!(err, Error::NothingQueued);
}
