/// Typed contract events, mirroring the `event` declarations in MimirSquad.sol.

use soroban_sdk::{contractevent, Address, String};

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MarketCreated {
    #[topic]
    pub market_id: u64,
    #[topic]
    pub captain: Address,
    pub deadline: u64,
    pub fee_bps: u32,
    pub question: String,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Deposited {
    #[topic]
    pub market_id: u64,
    #[topic]
    pub side: u32,
    #[topic]
    pub participant: Address,
    pub amount: i128,
    pub shares: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Withdrawn {
    #[topic]
    pub market_id: u64,
    #[topic]
    pub side: u32,
    #[topic]
    pub participant: Address,
    pub amount: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Resolved {
    #[topic]
    pub market_id: u64,
    pub result: u32,
    pub pool_a: i128,
    pub pool_b: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Claimed {
    #[topic]
    pub market_id: u64,
    #[topic]
    pub participant: Address,
    pub gross: i128,
    pub fee: i128,
    pub net: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeesClaimed {
    #[topic]
    pub recipient: Address,
    pub amount: i128,
}

/// Pool market state transition event for lifecycle auditing.
/// Emitted on every state change with previous and new states.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MarketStateTransitioned {
    #[topic]
    pub market_id: u64,
    pub from_state: u32,
    pub to_state: u32,
    pub timestamp: u64,
}

/// Emitted when a pool market's deadline passes and it becomes eligible for resolution.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MarketDeadlineReached {
    #[topic]
    pub market_id: u64,
    pub deadline: u64,
    pub pool_a_total: i128,
    pub pool_b_total: i128,
}

/// Emitted when liquidity is added to a pool market.
/// Tracks pool depth changes for analytics and risk management.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LiquidityAdded {
    #[topic]
    pub market_id: u64,
    #[topic]
    pub side: u32,
    pub amount: i128,
    pub new_pool_total: i128,
    pub shares_issued: i128,
}

/// Emitted when liquidity is removed from a pool market before resolution.
/// Distinguishes between pre-deadline withdrawals and post-resolution claims.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LiquidityRemoved {
    #[topic]
    pub market_id: u64,
    #[topic]
    pub side: u32,
    pub amount: i128,
    pub new_pool_total: i128,
    pub shares_burned: i128,
}

/// A captain cancelled a market before its deadline. Every depositor can pull
/// a full refund through `claim`; the pools are kept as an audit trail.
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

/// A payout could not be delivered (frozen or deauthorized trustline) and was
/// parked for a later `claim_parked_payout`.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PayoutParked {
    #[topic]
    pub market_id: u64,
    #[topic]
    pub side: u32,
    #[topic]
    pub participant: Address,
    pub amount: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OracleQueued {
    #[topic]
    pub next: Address,
    pub executable_at: u64,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OracleChanged {
    #[topic]
    pub next: Address,
    pub previous: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OracleCancelled {
    pub cancelled: bool,
}

/// Emitted when the current fee recipient queues a rotation to a new address.
/// The rotation becomes executable only at or after `executable_at`.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeeRecipientQueued {
    #[topic]
    pub next: Address,
    pub executable_at: u64,
}

/// Emitted when a queued fee recipier rotation is executed after the timelock.
/// Any fees accrued but unclaimed at execution time are payable to ``next``.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeeRecipientChanged {
    #[topic]
    pub next: Address,
    pub previous: Address,
}

/// Emitted when a queued fee recipient rotation is cancelled by the current recipient.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeeRecipientCancelled {
    pub cancelled: bool,
}

/// Emitted on the deposit that fills the squad to [`crate::types::MAX_SQUAD_MEMBERS`]
/// total participants. Subsequent deposits from new addresses are rejected
/// with [`crate::types::Error::SquadFull`] until existing members withdraw.
///
/// This event fires on the *last accepted* deposit rather than on the rejected
/// attempt: Soroban discards all events emitted by a failed invocation, so a
/// "cap hit" event can only be reliably indexed from a successful one.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SquadFull {
    #[topic]
    pub market_id: u64,
    pub total_members: u32,
}
