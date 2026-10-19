import assert from "node:assert/strict";
import test from "node:test";

import {
  actionLabel,
  headerWalletButtonLabel,
  spendPermissionLabel,
  srAddressLabel,
  statusDescription,
  walletRowLabel,
  type WalletActionKind,
  type WalletActionState,
} from "../../lib/wallet-aria";

// Sample Stellar strkeys (public account G... and contract C...)
const ACCOUNT_ADDR = "GB5DLP3MNPUXXJ6P67XGD3OV3ZVIMZN3NZDLVDIYQN6JSC2M7QMMBL4E";
const CONTRACT_ADDR = "CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5CVUPGDW3R2UMIVN";

// ── 1. actionLabel Table-Driven Tests ─────────────────────────────────────────

test("actionLabel covers all kinds in idle state", () => {
  const cases: Array<{
    kind: WalletActionKind;
    amount?: number | null;
    expected: string;
  }> = [
    { kind: "connect", expected: "Connect wallet" },
    { kind: "stake", amount: 10, expected: "Stake 10.00 USDC" },
    { kind: "stake", expected: "Stake" },
    { kind: "collect_payout", amount: 50.5, expected: "Collect payout 50.50 USDC" },
    { kind: "collect_payout", expected: "Collect payout" },
    { kind: "withdraw", amount: 20, expected: "Withdraw 20.00 USDC" },
    { kind: "withdraw", expected: "Withdraw" },
    { kind: "claim_fees", amount: 3.25, expected: "Claim fees 3.25 USDC" },
    { kind: "claim_fees", expected: "Claim fees" },
    { kind: "add_trustline", expected: "Add USDC trustline" },
    { kind: "cancel_market", expected: "Cancel market" },
    { kind: "request_resolve", expected: "Request resolution" },
    { kind: "reset_resolve", expected: "Reset resolve request" },
    { kind: "sign_message", expected: "Sign message" },
  ];

  for (const c of cases) {
    const actual = actionLabel(c.kind, "idle", undefined, c.amount);
    assert.equal(actual, c.expected, `idle label for ${c.kind}`);
  }
});

test("actionLabel covers connecting state with and without wallet name", () => {
  assert.equal(actionLabel("connect", "connecting"), "Connecting to wallet");
  assert.equal(actionLabel("connect", "connecting", null), "Connecting to wallet");
  assert.equal(actionLabel("connect", "connecting", "Freighter"), "Connecting to Freighter");
  assert.equal(actionLabel("stake", "connecting", "Lobstr"), "Connecting to Lobstr");
});

test("actionLabel covers signing state across all action kinds", () => {
  const cases: Array<{
    kind: WalletActionKind;
    walletName?: string;
    expected: string;
  }> = [
    { kind: "connect", walletName: "Freighter", expected: "Connecting to Freighter" },
    { kind: "connect", expected: "Connecting" },
    { kind: "stake", expected: "Confirming stake in your wallet" },
    { kind: "collect_payout", expected: "Confirming payout collection in your wallet" },
    { kind: "withdraw", expected: "Confirming withdrawal in your wallet" },
    { kind: "claim_fees", expected: "Confirming fee claim in your wallet" },
    { kind: "add_trustline", expected: "Confirming USDC trustline in your wallet" },
    { kind: "cancel_market", expected: "Confirming market cancellation in your wallet" },
    { kind: "request_resolve", expected: "Confirming resolution request in your wallet" },
    { kind: "reset_resolve", expected: "Confirming resolve reset in your wallet" },
    { kind: "sign_message", walletName: "xBull", expected: "Signing message to xBull" },
    { kind: "sign_message", expected: "Signing message" },
  ];

  for (const c of cases) {
    const actual = actionLabel(c.kind, "signing", c.walletName);
    assert.equal(actual, c.expected, `signing label for ${c.kind}`);
  }
});

test("actionLabel covers pending state across kinds", () => {
  const cases: Array<{ kind: WalletActionKind; expected: string }> = [
    { kind: "stake", expected: "Stake submitted — waiting for Stellar ledger" },
    { kind: "collect_payout", expected: "Payout collection submitted — waiting for Stellar ledger" },
    { kind: "withdraw", expected: "Withdrawal submitted — waiting for Stellar ledger" },
    { kind: "claim_fees", expected: "Fee claim submitted — waiting for Stellar ledger" },
    { kind: "add_trustline", expected: "Trustline submitted — waiting for Stellar ledger" },
    { kind: "cancel_market", expected: "Cancellation submitted — waiting for Stellar ledger" },
    { kind: "request_resolve", expected: "Resolution request submitted — waiting for Stellar ledger" },
    { kind: "reset_resolve", expected: "Resolve reset submitted — waiting for Stellar ledger" },
    { kind: "sign_message", expected: "Transaction submitted — waiting for Stellar ledger" },
    { kind: "connect", expected: "Transaction submitted — waiting for Stellar ledger" },
  ];

  for (const c of cases) {
    const actual = actionLabel(c.kind, "pending");
    assert.equal(actual, c.expected, `pending label for ${c.kind}`);
  }
});

test("actionLabel covers confirmed state with and without amounts", () => {
  const cases: Array<{
    kind: WalletActionKind;
    amount?: number | null;
    expected: string;
  }> = [
    { kind: "stake", amount: 15, expected: "Stake confirmed 15.00 USDC" },
    { kind: "stake", expected: "Stake confirmed" },
    { kind: "collect_payout", amount: 42.5, expected: "Payout collected 42.50 USDC" },
    { kind: "collect_payout", expected: "Payout collected" },
    { kind: "withdraw", amount: 10, expected: "Withdrawal confirmed 10.00 USDC" },
    { kind: "withdraw", expected: "Withdrawal confirmed" },
    { kind: "claim_fees", amount: 7.2, expected: "Fees claimed 7.20 USDC" },
    { kind: "claim_fees", expected: "Fees claimed" },
    { kind: "add_trustline", expected: "USDC trustline added successfully" },
    { kind: "cancel_market", expected: "Market cancelled — stake returned" },
    { kind: "request_resolve", expected: "Resolution request recorded on-chain" },
    { kind: "reset_resolve", expected: "Resolve request reset" },
    { kind: "sign_message", expected: "Transaction confirmed" },
  ];

  for (const c of cases) {
    const actual = actionLabel(c.kind, "confirmed", undefined, c.amount);
    assert.equal(actual, c.expected, `confirmed label for ${c.kind}`);
  }
});

test("actionLabel covers rejected state", () => {
  assert.equal(actionLabel("connect", "rejected"), "Connection rejected in wallet");
  assert.equal(actionLabel("connect", "rejected", "Freighter"), "Connection rejected to Freighter");
  assert.equal(actionLabel("add_trustline", "rejected"), "Trustline signature rejected in wallet");
  assert.equal(actionLabel("stake", "rejected"), "Stake rejected in wallet");
  assert.equal(actionLabel("withdraw", "rejected"), "Withdrawal rejected in wallet");
  assert.equal(actionLabel("cancel_market", "rejected"), "Market cancellation rejected in wallet");
});

test("actionLabel covers error, stale, duplicate, dependency_failure, cancelled states", () => {
  assert.equal(actionLabel("stake", "error"), "Stake failed");
  assert.equal(actionLabel("withdraw", "error"), "Withdrawal failed");

  assert.equal(actionLabel("stake", "stale"), "Stake — refreshing data");
  assert.equal(actionLabel("collect_payout", "stale"), "Payout collection — refreshing data");

  assert.equal(actionLabel("stake", "duplicate"), "Stake already completed");
  assert.equal(actionLabel("request_resolve", "duplicate"), "Resolution request already completed");

  assert.equal(actionLabel("stake", "dependency_failure"), "Cannot stake — USDC trustline not set up");
  assert.equal(
    actionLabel("withdraw", "dependency_failure"),
    "Cannot withdraw — a required setup step failed",
  );
  assert.equal(
    actionLabel("add_trustline", "dependency_failure"),
    "Cannot add trustline — a required setup step failed",
  );

  assert.equal(actionLabel("stake", "cancelled"), "Stake — market cancelled");
  assert.equal(actionLabel("collect_payout", "cancelled"), "Payout collection — market cancelled");
});

// ── 2. statusDescription Table-Driven Tests ───────────────────────────────────

test("statusDescription returns null for non-announcing states", () => {
  assert.equal(statusDescription("stake", "idle"), null);
  assert.equal(statusDescription("connect", "connecting"), null);
});

test("statusDescription handles signing and pending states", () => {
  assert.equal(
    statusDescription("stake", "signing"),
    "Open your wallet extension and approve the transaction.",
  );

  assert.equal(
    statusDescription("stake", "pending"),
    "The transaction has been submitted to the Stellar network. Stellar closes ledgers every ~5 seconds — the page will refresh when confirmed.",
  );
  assert.equal(
    statusDescription("stake", "pending", 25),
    "The transaction of 25.00 USDC has been submitted to the Stellar network. Stellar closes ledgers every ~5 seconds — the page will refresh when confirmed.",
  );
});

test("statusDescription handles confirmed state across all kinds with and without amount", () => {
  const cases: Array<{
    kind: WalletActionKind;
    amount?: number | null;
    expected: string;
  }> = [
    {
      kind: "stake",
      amount: 10,
      expected: "Your stake of 10.00 USDC is now recorded on Stellar. The market will refresh automatically.",
    },
    {
      kind: "stake",
      expected: "Your stake is now recorded on Stellar. The market will refresh automatically.",
    },
    {
      kind: "collect_payout",
      amount: 50,
      expected: "Your payout of 50.00 USDC has been transferred to your wallet.",
    },
    {
      kind: "collect_payout",
      expected: "Your payout has been transferred to your wallet.",
    },
    {
      kind: "withdraw",
      amount: 15,
      expected: "Your parked funds of 15.00 USDC have been returned to your wallet.",
    },
    {
      kind: "withdraw",
      expected: "Your parked funds have been returned to your wallet.",
    },
    {
      kind: "claim_fees",
      amount: 2.5,
      expected: "Your accrued fees of 2.50 USDC have been sent to your wallet.",
    },
    {
      kind: "claim_fees",
      expected: "Your accrued fees have been sent to your wallet.",
    },
    {
      kind: "add_trustline",
      expected: "Your wallet can now hold USDC. You can place your stake.",
    },
    {
      kind: "cancel_market",
      expected: "The market has been cancelled and your creator stake has been returned.",
    },
    {
      kind: "request_resolve",
      expected:
        "Your resolution request is recorded on-chain. Once both sides agree, Mimir will settle the claim.",
    },
    {
      kind: "sign_message",
      expected: "The transaction was confirmed on Stellar.",
    },
  ];

  for (const c of cases) {
    const actual = statusDescription(c.kind, "confirmed", c.amount);
    assert.equal(actual, c.expected, `confirmed description for ${c.kind}`);
  }
});

test("statusDescription handles rejected, error, stale, duplicate, dependency_failure and cancelled", () => {
  assert.equal(
    statusDescription("stake", "rejected"),
    "The transaction was rejected in your wallet. You can try again.",
  );
  assert.equal(
    statusDescription("stake", "error"),
    "An error occurred. Check your wallet balance and try again.",
  );
  assert.equal(
    statusDescription("stake", "stale"),
    "The on-chain state may have changed. Refreshing data now.",
  );
  assert.equal(
    statusDescription("stake", "duplicate"),
    "This action was already completed. Refresh the page to see the latest state.",
  );

  assert.equal(
    statusDescription("stake", "dependency_failure"),
    "Your wallet does not have a USDC trustline yet. Set it up using the button above, then try staking again.",
  );
  assert.equal(
    statusDescription("withdraw", "dependency_failure"),
    "A required setup step failed. Check the notices above and try again.",
  );

  assert.equal(
    statusDescription("stake", "cancelled"),
    "This market was cancelled before the action could complete. Your funds have not been moved.",
  );
});

// ── 3. walletRowLabel Table-Driven Tests ──────────────────────────────────────

test("walletRowLabel covers installed, uninstalled, recent and wrapper states", () => {
  const table = [
    {
      name: "Lobstr",
      opts: { installed: false, recent: false, wrapper: false },
      expected: "Get Lobstr — not installed",
    },
    {
      name: "Lobstr",
      opts: { installed: false, recent: true, wrapper: false },
      expected: "Get Lobstr — not installed", // not installed overrides recent
    },
    {
      name: "Freighter",
      opts: { installed: true, recent: false, wrapper: false },
      expected: "Connect with Freighter",
    },
    {
      name: "xBull",
      opts: { installed: true, recent: true, wrapper: false },
      expected: "Connect with xBull — last used",
    },
    {
      name: "Hana",
      opts: { installed: true, recent: false, wrapper: true },
      expected: "Connect with Hana — you are inside this wallet",
    },
    {
      name: "Hana",
      opts: { installed: true, recent: true, wrapper: true },
      expected: "Connect with Hana — you are inside this wallet", // wrapper overrides recent
    },
  ];

  for (const row of table) {
    const actual = walletRowLabel(row.name, row.opts);
    assert.equal(actual, row.expected);
  }
});

// ── 4. srAddressLabel Tests & Address Preservation Rules ──────────────────────

test("srAddressLabel preserves full unambiguous strkeys for screen readers", () => {
  // Without context
  assert.equal(srAddressLabel(ACCOUNT_ADDR), ACCOUNT_ADDR);
  assert.equal(srAddressLabel(CONTRACT_ADDR), CONTRACT_ADDR);

  // With context
  assert.equal(
    srAddressLabel(ACCOUNT_ADDR, "connected wallet"),
    `connected wallet: ${ACCOUNT_ADDR}`,
  );
  assert.equal(
    srAddressLabel(ACCOUNT_ADDR, "agent wallet"),
    `agent wallet: ${ACCOUNT_ADDR}`,
  );
});

test("srAddressLabel ensures address is never truncated or abbreviated", () => {
  // Stellar strkeys must be exactly 56 chars
  assert.equal(ACCOUNT_ADDR.length, 56);
  const label = srAddressLabel(ACCOUNT_ADDR, "connected");
  assert.ok(label.includes(ACCOUNT_ADDR));
  assert.ok(!label.includes("..."), "screen-reader label must never use ellipsis shortening");
});

// ── 5. headerWalletButtonLabel Table-Driven Tests ─────────────────────────────

test("headerWalletButtonLabel covers connecting, connected and disconnected states", () => {
  const table = [
    // Connecting states (connecting takes precedence)
    {
      address: null,
      isConnecting: true,
      walletName: "Freighter",
      expected: "Connecting to Freighter",
    },
    {
      address: null,
      isConnecting: true,
      walletName: null,
      expected: "Connecting to wallet",
    },
    {
      address: ACCOUNT_ADDR,
      isConnecting: true,
      walletName: "Lobstr",
      expected: "Connecting to Lobstr",
    },

    // Disconnected state
    {
      address: null,
      isConnecting: false,
      walletName: null,
      expected: "Connect wallet",
    },
    {
      address: null,
      isConnecting: false,
      walletName: "Freighter",
      expected: "Connect wallet",
    },

    // Connected state with and without walletName
    {
      address: ACCOUNT_ADDR,
      isConnecting: false,
      walletName: null,
      expected: `Connected wallet: ${ACCOUNT_ADDR}`,
    },
    {
      address: ACCOUNT_ADDR,
      isConnecting: false,
      walletName: "Freighter",
      expected: `Freighter wallet: ${ACCOUNT_ADDR}`,
    },
  ];

  for (const row of table) {
    const actual = headerWalletButtonLabel(row.address, row.isConnecting, row.walletName);
    assert.equal(actual, row.expected);
  }
});

// ── 6. spendPermissionLabel Tests ─────────────────────────────────────────────

test("spendPermissionLabel handles singular and plural expiry days and formatted amounts", () => {
  const table = [
    {
      opts: { spender: ACCOUNT_ADDR, amountUsdc: 20, expiryDays: 30 },
      expected: `Authorise ${ACCOUNT_ADDR} to spend up to 20.00 USDC on your behalf, expires in 30 days`,
    },
    {
      opts: { spender: ACCOUNT_ADDR, amountUsdc: 5.5, expiryDays: 1 },
      expected: `Authorise ${ACCOUNT_ADDR} to spend up to 5.50 USDC on your behalf, expires in 1 day`,
    },
    {
      opts: { spender: ACCOUNT_ADDR, amountUsdc: 0.123, expiryDays: 0 },
      expected: `Authorise ${ACCOUNT_ADDR} to spend up to 0.12 USDC on your behalf, expires in 0 days`,
    },
    {
      opts: { spender: CONTRACT_ADDR, amountUsdc: 1000, expiryDays: 7 },
      expected: `Authorise ${CONTRACT_ADDR} to spend up to 1000.00 USDC on your behalf, expires in 7 days`,
    },
  ];

  for (const row of table) {
    const actual = spendPermissionLabel(row.opts);
    assert.equal(actual, row.expected);
  }
});
