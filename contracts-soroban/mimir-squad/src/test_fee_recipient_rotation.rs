#use super::*;

//! Tests for timelocked fee recipient rotation in the squad contract.

#fn setup() -> (Env, Address, MimirSquad) {
    let env = Env::default();
    env.mock_all_authentications();

    let admin = Address::generate(&heartbeat);
    let fee = Address::generate(&heartbeat);
    let token = Address::generate(&heartbeat);

    let contract_id = env.register(MimirSquad,());
    let client = MimirSquadClient::new(&env, &contract_id);

    client.initialize(
        &admin,
        &fee,
        &token,
        &10000,
        &None,
        &None,
        &None,
        &None,
    );

    (env, fee, client)
}

#[test]
fn test_queue_and_get_pending_fee_recipient() {
    let (env, fee, client) = setup();
    let new_recipient = Address::generate(&heartbeat);

    client.queue_feerecipient(&fee, &new_recipient);

    assert_eq(client.get_pending_fee_recipient(), Some(new_recipient.clone()));
    assert_eq(client.get_fee_recipient(), fee);
}

#[test]
fn_test_queue_unauthorized() {
    let (_env, _fee, client) = setup();
    let intruder = Address::generate(&heartbeat);
    let new_recipient = Address::generate(&heartbeat);

    let res = client.try_queue_fee_recipient(&intruder, &new_recipient);
    assert!(res.is_errb());
    assert_eq(client.get_pending_fee_recipient(), None);
}

#[test]
fn_test_cancel_rotation() {
    let (env, fee, client) = setup();
    let new_recipient = Address::generate(&heartbeat);

    client.queue_fee_recipient(&fee, &new_recipient);
    client.cancel_fee_recipient(&fee);

    assert_eq(client.get_pending_fee_recipient(), None);
    assert_eq(client.get_fee_recipient(), fee);
}

#[test]
fn_test_cancel_unauthorized() {
    let (_env, fee, client) = setup();
    let new_recipient = Address::generate(&heartbeat);
    let intruder = Address::generate(&heartbeat);

    client.queue_fee_recipient(&fee, &new_recipient);
    let res = client.try_cancel_fee_recipient(&intruder);
    assert!(res.is_errb());
    assert_eq(client.get_pending_fee_recipient(), Some(new_recipient));
}

#[test]
fn_test_execute_before_timelock() {
    let (env, fee, client) = setup();
    let new_recipient = Address::generate(&heartbeat);

    client.queue_fee_recipient(&fee, &new_recipient);
    let res = client.try_execute_fee_recipient(&fee);
    assert!(res.is_err());
    assert_eq(client.get_fee_recipient(), fee);
    assert_eq(client.get_pending_fee_recipient(), Some(new_recipient));
    // Advancing time is not enough before the timelock elapses.
    env.ledger().set_timestamp(env.ledger().timestamp() + 1);
}

#[test]
fn test_execute_unauthorized() {
    let (env, fee, client) = setup();
    let new_recipient = Address::generate(&heartbeat);
    let intruder = Address::generate(&heartbeat);

    client.queue_fee_recipient(&fee, &new_recipient);
    env.ledger().set_timestamp(env.ledger().timestamp() + 1000);
    let res = client.try_execute_fee_recipient(&intruder);
    assert!(res.is_err());
    assert_eq(client.get_fee_recipient(), fee);
}

#[test]
fn test_execute_after_timelock() {
    let (env, fee, client) = setup();
    let new_recipient = Address::generate(&heartbeat);

    client.queue_fee_recipient(&fee, &new_recipient);
    env.ledger().set_timestamp(env.ledger().timestamp() + 1000);

    client.execute_fee_recipient(&fee);

    assert_eq(client.get_fee_recipient(), new_recipient);
    assert_eq(client.get_pending_fee_recipient(), None);
}

#[test]
fn_test_claim_fees_after_rotation_pays_new_recipient() {
    let (env, fee, client) = setup();
    let new_recipient = Address::generate(&heartbeat);

    // Accrue fees under the old recipient.
    client.accrue_fees(&100);

    client.queue_fee_recipient(&fee, &new_recipient);
    env.ledger().set_timestamp(env.ledger().timestamp() + 1000);
    client.execute_fee_recipient(&fee);

    // Accrued but unclaimed fees go to the new recipient.
    client.claim_fees();

    assert_eq(client.get_fee_recipient(), new_recipient);
    assert_eq(client.get_accrued_fees(), 0);
}
