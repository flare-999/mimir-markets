import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_SETTLEMENT_RETRY_CONFIG,
  SETTLEMENT_ERROR_CLASSES,
  StellarTransactionError,
  classifySettlementError,
  loadSettlementRetryConfig,
  settlementRetryDecision,
  settlementSnapshotIsReady,
  wrapStellarTransactionError,
} from "../../lib/settlement-retry";

const transient = { message: "Soroban RPC timeout while submitting transaction" };

// ── Error classes ─────────────────────────────────────────────────────────────

test("settlement error classes are explicit and exhaustive", () => {
  assert.deepEqual([...SETTLEMENT_ERROR_CLASSES], [
    "malformed",
    "stale",
    "duplicate",
    "cancelled",
    "paused",
    "dependency-failure",
  ]);
});

test("malformed verdict errors never become retryable transaction errors", () => {
  const result = classifySettlementError(new Error("invalid-json after 2 attempts"));
  assert.equal(result.kind, "malformed");
  assert.equal(settlementRetryDecision(result, 1).action, "abort");
});

test("stale Soroban lifecycle errors refresh chain state instead of replaying", () => {
  assert.equal(classifySettlementError(new Error("resolve_claim: NotYetExpired")).kind, "stale");
  assert.equal(classifySettlementError(new Error("Error(Contract, #21)")).kind, "stale");
  const decision = settlementRetryDecision(classifySettlementError(new Error("ClaimNotActive")), 1);
  assert.equal(decision.action, "refresh");
});

test("duplicate and cancelled chain outcomes are safe terminal no-ops", () => {
  const duplicate = classifySettlementError(new Error("claim already resolved"));
  const cancelled = classifySettlementError(new Error("ClaimCancelled: cancelled on chain"));
  assert.equal(duplicate.kind, "duplicate");
  assert.equal(cancelled.kind, "cancelled");
  assert.equal(settlementRetryDecision(duplicate, 1).action, "skip");
  assert.equal(settlementRetryDecision(cancelled, 1).action, "skip");
});

test("operator pause defers before any funded retry", () => {
  const info = classifySettlementError(new Error("oracle_settlement capability paused"));
  assert.equal(info.kind, "paused");
  assert.equal(settlementRetryDecision(info, 1).action, "defer");
});

test("permission failures are malformed and never retried as a money call", () => {
  const info = classifySettlementError(new Error("resolve_claim: tx_bad_auth / NotOracle"));
  assert.equal(info.kind, "malformed");
  assert.equal(settlementRetryDecision(info, 1).action, "abort");
});

test("dependency failures retry with exponential backoff and stop at the budget", () => {
  const info = classifySettlementError(transient);
  assert.equal(info.kind, "dependency-failure");
  const config = { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 150 };
  assert.deepEqual(settlementRetryDecision(info, 1, config), {
    action: "retry",
    attempt: 1,
    delayMs: 100,
    reason: "dependency failure; bounded retry 2/3",
  });
  assert.equal(settlementRetryDecision(info, 2, config).delayMs, 150);
  assert.equal(settlementRetryDecision(info, 3, config).action, "defer");
});

test("unknown failures fail closed as bounded dependency failures", () => {
  const info = classifySettlementError({ unexpected: "shape" });
  assert.equal(info.kind, "dependency-failure");
  assert.equal(settlementRetryDecision(info, DEFAULT_SETTLEMENT_RETRY_CONFIG.maxAttempts).action, "defer");
});

// ── Chain-state boundary ──────────────────────────────────────────────────────

test("settlement snapshot allows active claims exactly at the deadline", () => {
  assert.equal(settlementSnapshotIsReady({ state: "active", deadline: 100 }, 100), true);
  assert.equal(settlementSnapshotIsReady({ state: "active", deadline: 101 }, 100), false);
  assert.equal(settlementSnapshotIsReady({ state: "open", deadline: 1 }, 100), false);
  assert.equal(settlementSnapshotIsReady({ state: "resolved", deadline: 1 }, 100), false);
});

// ── Configuration and transaction identity ─────────────────────────────────────

test("retry configuration uses defaults when unset", () => {
  const result = loadSettlementRetryConfig({});
  assert.deepEqual(result.config, DEFAULT_SETTLEMENT_RETRY_CONFIG);
  assert.deepEqual(result.warnings, []);
});

test("retry configuration validates bounds and reports deployment mistakes", () => {
  const result = loadSettlementRetryConfig({
    ORACLE_SETTLEMENT_TX_MAX_ATTEMPTS: "0",
    ORACLE_SETTLEMENT_TX_RETRY_BASE_MS: "-1",
    ORACLE_SETTLEMENT_TX_RETRY_MAX_MS: "not-a-number",
  });
  assert.deepEqual(result.config, DEFAULT_SETTLEMENT_RETRY_CONFIG);
  assert.equal(result.warnings.length, 3);
});

test("retry configuration clamps a max delay below the base delay", () => {
  const result = loadSettlementRetryConfig({
    ORACLE_SETTLEMENT_TX_RETRY_BASE_MS: "5000",
    ORACLE_SETTLEMENT_TX_RETRY_MAX_MS: "1000",
  });
  assert.equal(result.config.baseDelayMs, 5000);
  assert.equal(result.config.maxDelayMs, 5000);
  assert.ok(result.warnings.some((warning) => warning.includes("below the base delay")));
});

test("Stellar transaction errors preserve a safe hash for reconciliation", () => {
  const wrapped = wrapStellarTransactionError(new Error("RPC timeout"), {
    label: "resolve_claim",
    phase: "result",
    txHash: "a".repeat(64),
  });
  assert.ok(wrapped instanceof StellarTransactionError);
  assert.equal(wrapped.txHash, "a".repeat(64));
  assert.equal(wrapped.phase, "result");
  assert.equal(classifySettlementError(wrapped).txHash, "a".repeat(64));
});

test("operational details redact seeds and credentials", () => {
  const info = classifySettlementError(new Error("RPC timeout bearer=secret-value SABCDEFGHJKLMNOPQRSTUVWXYZ234567"));
  assert.equal(info.kind, "dependency-failure");
  assert.ok(!info.detail.includes("secret-value"));
  assert.ok(!info.detail.includes("SABCDEFGHJKLMNOPQRSTUVWXYZ234567"));
});
