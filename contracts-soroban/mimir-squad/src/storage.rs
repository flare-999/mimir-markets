//! Storage keys and typed accessors.

use soroban_sdk::{contracttype, Address, Env};

use crate::types::{Error, Market, PendingFeeRecipient, PendingOracle};

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Init,
    Usdc,
    Oracle,
    FeeRecipient,
    PendingOracle,
    PendingFeeRecipient,
    MarketCount,
    AccruedFees,
    Market(u64),
    /// Global pause flag. When set, state-mutating entry points that are not
    /// withdrawals are rejected. Withdrawals (claim, claim_parked_payout)
    /// MUST remain available while paused.
    Paused,
    /// (market, side, participant) -> deposited units. Shares equal units.
    Deposit(u64, u32, Address),
    /// (market, side, participant) -> already claimed.
    Claimed(u64, u32, Address),
    /// (market, side, participant) -> payout settled in the ledger but not
    /// delivered, because the token transfer trapped (frozen or deauthorized
    /// trustline). Parked until `claim_parked_payout` can move it.
    Payout(u64, u32, Address),
}

const BUMP_THRESHOLD: u32 = 120_960;
const BUMP_EXTEND: u32 = 518_400;

// ── Config ───────────────────────────────────────────────────────────────────

pub fn is_initialized(env: &Env) -> bool {
    env.storage().instance().has(&DataKey::Init)
}

pub fn mark_initialized(env: &Env) {
    env.storage().instance().set(&DataKey::Init, &true);
}

fn address(env: &Env, key: DataKey) -> Result<Address, Error> {
    env.storage()
        .instance()
        .get(&key)
        .ok_or(Error::NotInitialized)
}

pub fn usdc(env: &Env) -> Result<Address, Error> {
    address(env, DataKey::Usdc)
}

pub fn oracle(env: &Env) -> Result<Address, Error> {
    address(env, DataKey::Oracle)
}

pub fn fee_recipient(env: &Env) -> Result<Address, Error> {
    address(env, DataKey::FeeRecipient)
}

pub fn set_config(env: &Env, usdc: &Address, oracle: &Address, fee_recipient: &Address) {
    env.storage().instance().set(&DataKey::Usdc, usdc);
    env.storage().instance().set(&DataKey::Oracle, oracle);
    env.storage()
        .instance()
        .set(&DataKey::FeeRecipient, fee_recipient);
}

pub fn set_oracle(env: &Env, oracle: &Address) {
    env.storage().instance().set(&DataKey::Oracle, oracle);
}

// ── Pause ────────────────────────────────────────────────────────────────────

/// Returns true when the contract is paused. Pause only gates non-withdrawal
/// state mutations; withdrawal paths must not consult this flag.
pub fn is_paused(env: &Env) -> bool {
    env.storage()
        .instance()
        .get(&DataKey::Paused)
        .unwrap_or(false)
}

pub fn set_paused(env: &Env, paused: bool) {
    env.storage().instance().set(&DataKey::Paused, &paused);
}

/// How long a queued oracle rotation must wait before it can be executed.
pub const ORACLE_TIMELOCK_SECONDS: u64 = 86_400;


pub fn pending_oracle(env: &Env) -> Option<PendingOracle> {
    env.storage().instance().get(&DataKey::PendingOracle)
}

pub fn set_pending_oracle(env: &Env, pending: &PendingOracle) {
    env.storage().instance().set(&DataKey::PendingOracle, pending);
}

pub fn clear_pending_oracle(env: &Env) {
    env.storage().instance().remove(&DataKey::PendingOracle);
}

pub fn set_fee_recipient(env: &Env, recipient: &Address) {
    env.storage()
        .instance()
        .set(&DataKey::FeeRecipient, recipient);
}

pub fn pending_fee_recipient(env: &Env) -> Option<PendingFeeRecipient> {
    env.storage().instance().get(&DataKey::PendingFeeRecipient)
}

pub fn set_pending_fee_recipient(env: &Env, pending: &PendingFeeRecipient) {
    env.storage()
        .instance()
        .set(&DataKey::PendingFeeRecipient, pending);
}

pub fn clear_pending_fee_recipient(env: &Env) {
    env.storage().instance().remove(&DataKey::PendingFeeRecipient);
}

// ── Counters ─────────────────────────────────────────────────────────────────

pub fn market_count(env: &Env) -> u64 {
    env.storage()
        .instance()
        .get(&DataKey::MarketCount)
        .unwrap_or(0)
}

pub fn set_market_count(env: &Env, value: u64) {
    env.storage().instance().set(&DataKey::MarketCount, &value);
}

pub fn accrued_fees(env: &Env) -> i128 {
    env.storage()
        .instance()
        .get(&DataKey::AccruedFees)
        .unwrap_or(0)
}

pub fn set_accrued_fees(env: &Env, value: i128) {
    env.storage().instance().set(&DataKey::AccruedFees, &value);
}

// ── Markets ──────────────────────────────────────────────────────────────────

pub fn get_market(env: &Env, id: u64) -> Result<Market, Error> {
    let key = DataKey::Market(id);
    let market: Market = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(Error::MarketNotFound)?;
    env.storage()
        .persistent()
        .extend_ttl(&key, BUMP_THRESHOLD, BUMP_EXTEND);
    Ok(market)
}

pub fn get_market_opt(env: &Env, id: u64) -> Option<Market> {
    let key = DataKey::Market(id);
    match env.storage().persistent().get::<_, Market>(&key) {
        Some(market) => {
            env.storage()
                .persistent()
                .extend_ttl(&key, BUMP_THRESHOLD, BUMP_EXTEND);
            Some(market)
        }
        None => None,
    }
}

pub fn set_market(env: &Env, id: u64, market: &Market) {
    let key = DataKey::Market(id);
    env.storage().persistent().set(&key, market);
    env.storage()
        .persistent()
        .extend_ttl(&key, BUMP_THRESHOLD, BUMP_EXTEND);
}

// ── Deposits & claims ────────────────────────────────────────────────────────

pub fn deposit_of(env: &Env, id: u64, side: u32, who: &Address) -> i128 {
    env.storage()
        .persistent()
        .get(&DataKey::Deposit(id, side, who.clone()))
        .unwrap_or(0)
}

pub fn set_deposit(env: &Env, id: u64, side: u32, who: &Address, value: i128) {
    let key = DataKey::Deposit(id, side, who.clone());
    if value == 0 {
        env.storage().persistent().remove(&key);
        return;
    }
    env.storage().persistent().set(&key, &value);
    env.storage()
        .persistent()
        .extend_ttl(&key, BUMP_THRESHOLD, BUMP_EXTEND);
}

pub fn has_claimed(env: &Env, id: u64, side: u32, who: &Address) -> bool {
    env.storage()
        .persistent()
        .has(&DataKey::Claimed(id, side, who.clone()))
}

pub fn mark_claimed(env: &Env, id: u64, side: u32, who: &Address) {
    let key = DataKey::Claimed(id, side, who.clone());
    env.storage().persistent().set(&key, &true);
    env.storage()
        .persistent()
        .extend_ttl(&key, BUMP_THRESHOLD, BUMP_EXTEND);
}

// ── Parked payouts ───────────────────────────────────────────────────────────

/// Payout settled in the ledger but not delivered yet. Zero means nothing is
/// parked, and writing zero removes the entry rather than storing a zero.
pub fn payout_of(env: &Env, id: u64, side: u32, who: &Address) -> i128 {
    env.storage()
        .persistent()
        .get(&DataKey::Payout(id, side, who.clone()))
        .unwrap_or(0)
}

pub fn set_payout(env: &Env, id: u64, side: u32, who: &Address, value: i128) {
    let key = DataKey::Payout(id, side, who.clone());
    if value == 0 {
        env.storage().persistent().remove(&key);
        return;
    }
    env.storage().persistent().set(&key, &value);
    env.storage()
        .persistent()
        .extend_ttl(&key, BUMP_THRESHOLD, BUMP_EXTEND);
}