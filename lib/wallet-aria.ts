/**
 * Accessible label builders for wallet action states.
 *
 * All functions are pure and side-effect-free so they can be used in both React
 * components and in tests without a browser. Nothing here references the React
 * tree, the wallet context, or live credentials — callers pass in the values they
 * already hold, so this module is safe to import anywhere.
 *
 * ── Why a separate module, not inline strings? ───────────────────────────────
 *
 * Wallet actions surface in at least five places: the picker modal, the Header
 * connect button, AccountBalances, ClaimPayoutCard, and UsdcTrustlineGate. Each
 * was carrying its own half-formed label. Centralising them means:
 *
 *   • one place to audit what a screen reader actually says in each state,
 *   • type-safety over the set of states (the union is exhaustive),
 *   • unit tests that cover every combination without a browser,
 *   • a clean boundary so future locale translation replaces *these* strings and
 *     nothing else.
 *
 * ── Privacy and address handling ─────────────────────────────────────────────
 *
 * Stellar strkeys are 56 character base32 strings starting with G (accounts) or
 * C (contracts). Mimir truncates them visually to a short form (first 4 + last 4
 * characters) for display, but a screen reader should always get the full address
 * so the user can confirm which wallet is connected — verifying a truncated
 * address defeats the purpose.
 *
 * NEVER expose a seed (S…) or raw private key through any label built here. The
 * only addresses that appear are public G… strkeys from the wallet context.
 *
 * ── Analytics fields ─────────────────────────────────────────────────────────
 *
 * The analytics envelope that rides alongside a wallet action (claim_id, category,
 * settlement_mode, tx_status) is logged server-side only. None of those fields
 * belong in an aria-label — they would be read aloud to users who have no context
 * for them. The exception is tx_status, which maps onto the human-readable state
 * strings below ("pending", "confirmed", etc.) and IS included, through the state
 * parameter.
 */

// ── State discriminant ────────────────────────────────────────────────────────

/**
 * Every state a wallet action can be in, from the user's perspective.
 *
 * - connecting: the wallet picker is open or the extension is being asked
 * - signing:    a transaction or message is waiting for the user's approval
 * - pending:    the signed transaction has been submitted; waiting for ledger
 * - confirmed:  the transaction was included in a ledger (Stellar is final)
 * - rejected:   the user declined to sign in their wallet
 * - error:      any other failure (network, insufficient balance, contract revert)
 * - stale:      data may be out of date, the contract state should be re-read
 * - duplicate:  the same action was already submitted and confirmed
 * - dependency_failure: a prerequisite (e.g. trustline) failed before the action
 * - cancelled:  the market was cancelled before the action could complete
 * - idle:       no action in progress; no label needed
 */
export type WalletActionState =
  | "idle"
  | "connecting"
  | "signing"
  | "pending"
  | "confirmed"
  | "rejected"
  | "error"
  | "stale"
  | "duplicate"
  | "dependency_failure"
  | "cancelled";

/**
 * The category of action, used to build more specific labels.
 *
 * - connect:           opening a wallet connection
 * - stake:             placing a USDC bet (challenge_claim)
 * - collect_payout:    pulling challenger payout (claim_challenger_payout)
 * - withdraw:          pulling parked funds (withdraw)
 * - claim_fees:        pulling accrued fees (claim_fees)
 * - add_trustline:     first-time USDC trustline setup (change_trust)
 * - cancel_market:     creator cancels an open unchallenged market
 * - request_resolve:   participant requests resolution after deadline
 * - reset_resolve:     participant resets a stalled resolve request
 * - sign_message:      off-chain attestation (basket subscription, agent registration)
 */
export type WalletActionKind =
  | "connect"
  | "stake"
  | "collect_payout"
  | "withdraw"
  | "claim_fees"
  | "add_trustline"
  | "cancel_market"
  | "request_resolve"
  | "reset_resolve"
  | "sign_message";

// ── Primary button label ──────────────────────────────────────────────────────

/**
 * The aria-label for the primary action button.
 *
 * In the active states (signing/pending) the label says *what is happening*
 * rather than what the button does; the button is aria-busy=true and disabled, so
 * this is an announcement, not a call to action.
 *
 * The wallet name is optional: include it when the UX makes it meaningful (the
 * picker modal), omit it when the context already names the wallet (the header).
 *
 * @example
 *   actionLabel("stake", "signing")
 *   // → "Confirming stake in your wallet"
 *
 *   actionLabel("connect", "connecting", "Freighter")
 *   // → "Connecting to Freighter"
 *
 *   actionLabel("stake", "idle", undefined, 5)
 *   // → "Stake 5 USDC"
 */
export function actionLabel(
  kind: WalletActionKind,
  state: WalletActionState,
  walletName?: string | null,
  amountUsdc?: number | null,
): string {
  const wallet = walletName ? ` to ${walletName}` : "";

  switch (state) {
    case "connecting":
      return walletName ? `Connecting${wallet}` : "Connecting to wallet";
    case "signing":
      return signingLabel(kind, wallet);
    case "pending":
      return pendingLabel(kind);
    case "confirmed":
      return confirmedLabel(kind, amountUsdc);
    case "rejected":
      return rejectedLabel(kind, wallet);
    case "error":
      return `${kindTitle(kind)} failed`;
    case "stale":
      return `${kindTitle(kind)} — refreshing data`;
    case "duplicate":
      return `${kindTitle(kind)} already completed`;
    case "dependency_failure":
      return dependencyFailureLabel(kind);
    case "cancelled":
      return `${kindTitle(kind)} — market cancelled`;
    case "idle":
      return idleLabel(kind, amountUsdc);
  }
}

function signingLabel(kind: WalletActionKind, walletSuffix: string): string {
  switch (kind) {
    case "connect":
      return `Connecting${walletSuffix}`;
    case "stake":
      return "Confirming stake in your wallet";
    case "collect_payout":
      return "Confirming payout collection in your wallet";
    case "withdraw":
      return "Confirming withdrawal in your wallet";
    case "claim_fees":
      return "Confirming fee claim in your wallet";
    case "add_trustline":
      return "Confirming USDC trustline in your wallet";
    case "cancel_market":
      return "Confirming market cancellation in your wallet";
    case "request_resolve":
      return "Confirming resolution request in your wallet";
    case "reset_resolve":
      return "Confirming resolve reset in your wallet";
    case "sign_message":
      return `Signing message${walletSuffix}`;
  }
}

function pendingLabel(kind: WalletActionKind): string {
  switch (kind) {
    case "stake":
      return "Stake submitted — waiting for Stellar ledger";
    case "collect_payout":
      return "Payout collection submitted — waiting for Stellar ledger";
    case "withdraw":
      return "Withdrawal submitted — waiting for Stellar ledger";
    case "claim_fees":
      return "Fee claim submitted — waiting for Stellar ledger";
    case "add_trustline":
      return "Trustline submitted — waiting for Stellar ledger";
    case "cancel_market":
      return "Cancellation submitted — waiting for Stellar ledger";
    case "request_resolve":
      return "Resolution request submitted — waiting for Stellar ledger";
    case "reset_resolve":
      return "Resolve reset submitted — waiting for Stellar ledger";
    default:
      return "Transaction submitted — waiting for Stellar ledger";
  }
}

function confirmedLabel(kind: WalletActionKind, amount?: number | null): string {
  const amt = amount != null ? ` ${amount.toFixed(2)} USDC` : "";
  switch (kind) {
    case "stake":
      return `Stake confirmed${amt}`;
    case "collect_payout":
      return `Payout collected${amt}`;
    case "withdraw":
      return `Withdrawal confirmed${amt}`;
    case "claim_fees":
      return `Fees claimed${amt}`;
    case "add_trustline":
      return "USDC trustline added successfully";
    case "cancel_market":
      return "Market cancelled — stake returned";
    case "request_resolve":
      return "Resolution request recorded on-chain";
    case "reset_resolve":
      return "Resolve request reset";
    default:
      return "Transaction confirmed";
  }
}

function rejectedLabel(kind: WalletActionKind, walletSuffix: string): string {
  switch (kind) {
    case "connect":
      return `Connection rejected${walletSuffix || " in wallet"}`;
    case "add_trustline":
      return "Trustline signature rejected in wallet";
    default:
      return `${kindTitle(kind)} rejected in wallet`;
  }
}

function dependencyFailureLabel(kind: WalletActionKind): string {
  switch (kind) {
    case "stake":
      return "Cannot stake — USDC trustline not set up";
    default:
      return `Cannot ${kindVerb(kind)} — a required setup step failed`;
  }
}

function idleLabel(kind: WalletActionKind, amount?: number | null): string {
  const amt = amount != null ? ` ${amount.toFixed(2)} USDC` : "";
  switch (kind) {
    case "connect":
      return "Connect wallet";
    case "stake":
      return `Stake${amt}`;
    case "collect_payout":
      return `Collect payout${amt}`;
    case "withdraw":
      return `Withdraw${amt}`;
    case "claim_fees":
      return `Claim fees${amt}`;
    case "add_trustline":
      return "Add USDC trustline";
    case "cancel_market":
      return "Cancel market";
    case "request_resolve":
      return "Request resolution";
    case "reset_resolve":
      return "Reset resolve request";
    case "sign_message":
      return "Sign message";
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function kindTitle(kind: WalletActionKind): string {
  switch (kind) {
    case "connect":
      return "Connection";
    case "stake":
      return "Stake";
    case "collect_payout":
      return "Payout collection";
    case "withdraw":
      return "Withdrawal";
    case "claim_fees":
      return "Fee claim";
    case "add_trustline":
      return "USDC trustline setup";
    case "cancel_market":
      return "Market cancellation";
    case "request_resolve":
      return "Resolution request";
    case "reset_resolve":
      return "Resolve reset";
    case "sign_message":
      return "Message signing";
  }
}

function kindVerb(kind: WalletActionKind): string {
  switch (kind) {
    case "connect":
      return "connect";
    case "stake":
      return "stake";
    case "collect_payout":
      return "collect payout";
    case "withdraw":
      return "withdraw";
    case "claim_fees":
      return "claim fees";
    case "add_trustline":
      return "add trustline";
    case "cancel_market":
      return "cancel market";
    case "request_resolve":
      return "request resolution";
    case "reset_resolve":
      return "reset resolve request";
    case "sign_message":
      return "sign message";
  }
}

// ── Status description (aria-describedby) ────────────────────────────────────

/**
 * A longer description for aria-describedby, used when the action state changes
 * and a live region should announce more detail than the button label alone.
 *
 * @example
 *   statusDescription("stake", "pending")
 *   // → "Your stake transaction has been submitted to the Stellar network. The
 *   //    page will refresh when it is confirmed."
 */
export function statusDescription(
  kind: WalletActionKind,
  state: WalletActionState,
  amountUsdc?: number | null,
): string | null {
  const amt = amountUsdc != null ? ` of ${amountUsdc.toFixed(2)} USDC` : "";

  switch (state) {
    case "signing":
      return "Open your wallet extension and approve the transaction.";
    case "pending":
      return `The transaction${amt} has been submitted to the Stellar network. Stellar closes ledgers every ~5 seconds — the page will refresh when confirmed.`;
    case "confirmed":
      return confirmedDescription(kind, amountUsdc);
    case "rejected":
      return "The transaction was rejected in your wallet. You can try again.";
    case "error":
      return "An error occurred. Check your wallet balance and try again.";
    case "stale":
      return "The on-chain state may have changed. Refreshing data now.";
    case "duplicate":
      return "This action was already completed. Refresh the page to see the latest state.";
    case "dependency_failure":
      return dependencyFailureDescription(kind);
    case "cancelled":
      return "This market was cancelled before the action could complete. Your funds have not been moved.";
    default:
      return null;
  }
}

function confirmedDescription(kind: WalletActionKind, amount?: number | null): string {
  const amt = amount != null ? ` of ${amount.toFixed(2)} USDC` : "";
  switch (kind) {
    case "stake":
      return `Your stake${amt} is now recorded on Stellar. The market will refresh automatically.`;
    case "collect_payout":
      return `Your payout${amt} has been transferred to your wallet.`;
    case "withdraw":
      return `Your parked funds${amt} have been returned to your wallet.`;
    case "claim_fees":
      return `Your accrued fees${amt} have been sent to your wallet.`;
    case "add_trustline":
      return "Your wallet can now hold USDC. You can place your stake.";
    case "cancel_market":
      return "The market has been cancelled and your creator stake has been returned.";
    case "request_resolve":
      return "Your resolution request is recorded on-chain. Once both sides agree, Mimir will settle the claim.";
    default:
      return "The transaction was confirmed on Stellar.";
  }
}

function dependencyFailureDescription(kind: WalletActionKind): string {
  switch (kind) {
    case "stake":
      return "Your wallet does not have a USDC trustline yet. Set it up using the button above, then try staking again.";
    default:
      return "A required setup step failed. Check the notices above and try again.";
  }
}

// ── Wallet picker row label ───────────────────────────────────────────────────

/**
 * Full aria-label for a wallet picker row.
 *
 * The visible text already shows the wallet name; the label adds context so a
 * screen reader user knows what the row does and whether it needs an install step.
 *
 * @example
 *   walletRowLabel("Freighter", { installed: true, recent: false, wrapper: false })
 *   // → "Connect with Freighter"
 *
 *   walletRowLabel("Lobstr", { installed: false, recent: false, wrapper: false })
 *   // → "Get Lobstr — not installed"
 *
 *   walletRowLabel("xBull", { installed: true, recent: true, wrapper: false })
 *   // → "Connect with xBull — last used"
 */
export function walletRowLabel(
  walletName: string,
  opts: { installed: boolean; recent: boolean; wrapper: boolean },
): string {
  if (!opts.installed) return `Get ${walletName} — not installed`;
  const suffix = opts.wrapper
    ? " — you are inside this wallet"
    : opts.recent
      ? " — last used"
      : "";
  return `Connect with ${walletName}${suffix}`;
}

// ── Address display ───────────────────────────────────────────────────────────

/**
 * The sr-only text that accompanies a truncated address display.
 *
 * This goes inside a `<span className="sr-only">` next to the visual short form
 * so a screen reader announces the full address without visible clutter.
 *
 * Stellar strkeys are 56-character base32 — long but unambiguous. We present the
 * full string rather than a further abbreviation because "G A R C … F R V X" is
 * the exact information the user needs to verify their wallet is the right one.
 *
 * NEVER pass a seed (S…) key through this function. Only public G… or C… strkeys
 * belong in any label or attribute exposed to the browser.
 *
 * @example
 *   srAddressLabel("GABC...XYZ", "connected wallet")
 *   // → "connected wallet: GABC...XYZ"
 */
export function srAddressLabel(address: string, context?: string): string {
  const prefix = context ? `${context}: ` : "";
  return `${prefix}${address}`;
}

/**
 * Build the connected-wallet aria-label for the header button.
 *
 * When connected the label reads the full address so a screen reader user can
 * distinguish "GA…" from "GB…" without reading the visual short form.
 */
export function headerWalletButtonLabel(
  address: string | null,
  isConnecting: boolean,
  walletName?: string | null,
): string {
  if (isConnecting) return walletName ? `Connecting to ${walletName}` : "Connecting to wallet";
  if (!address) return "Connect wallet";
  const name = walletName ? `${walletName} wallet: ` : "Connected wallet: ";
  return `${name}${address}`;
}

// ── Permission and spend-permission context ───────────────────────────────────

/**
 * Human-readable label for a spend-permission scope, used in the BYOA onboarding
 * form and any aria-describedby that names the permission being granted.
 *
 * The values here deliberately parallel what is committed to the Stellar Asset
 * Contract allowance (spender G… address, amount, expiry ledger). They are
 * suitable for aria-describedby or a screen-reader announcement but must NOT be
 * treated as the authoritative permission record — the chain is the source of
 * truth.
 *
 * @example
 *   spendPermissionLabel({ spender: "GABC...", amountUsdc: 20, expiryDays: 30 })
 *   // → "Authorise GABC... to spend up to 20.00 USDC on your behalf, expires in 30 days"
 */
export function spendPermissionLabel(opts: {
  spender: string;
  amountUsdc: number;
  expiryDays: number;
}): string {
  return `Authorise ${opts.spender} to spend up to ${opts.amountUsdc.toFixed(2)} USDC on your behalf, expires in ${opts.expiryDays} day${opts.expiryDays === 1 ? "" : "s"}`;
}
