/**
 * tests/node/vs-events.test.ts
 *
 * Unit tests for the pure change-detection helper and SSE utilities in lib/vs-events.ts.
 * Coverage: positive, negative, boundary, and regression test cases.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  detectVsIndexChange,
  hasVsChanged,
  formatSseComment,
  formatSseData,
  formatSseEvent,
  formatSseRetry,
  SSE_HEARTBEAT_INTERVAL_MS,
  SSE_MAX_DURATION_MS,
  SSE_POLL_INTERVAL_MS,
  SSE_RETRY_MS,
  type VsIndexFingerprint,
} from "../../lib/vs-events";

function makeFingerprint(overrides: Partial<VsIndexFingerprint> = {}): VsIndexFingerprint {
  return {
    claimId: 42,
    updatedAt: 1700000000,
    reasoningCount: 3,
    ...overrides,
  };
}

// ── Timing Constants ──────────────────────────────────────────────────────────

test("constants: serverless SSE timing parameters are properly configured", () => {
  assert.equal(SSE_POLL_INTERVAL_MS, 2_000, "Server polls index within a few seconds");
  assert.equal(SSE_HEARTBEAT_INTERVAL_MS, 15_000, "Heartbeat fires every 15s");
  assert.equal(SSE_MAX_DURATION_MS, 45_000, "Max duration under 60s serverless limit");
  assert.equal(SSE_RETRY_MS, 2_000, "Client reconnect hint is 2s");
});

// ── Initial State Detection ───────────────────────────────────────────────────

test("positive: null previous state triggers initial change detection", () => {
  const current = makeFingerprint();
  const result = detectVsIndexChange(null, current);

  assert.equal(result.hasChanged, true);
  assert.equal(result.reason, "initial");
  assert.equal(result.previous, null);
  assert.deepEqual(result.current, current);
  assert.equal(hasVsChanged(null, current), true);
});

test("positive: claimId change triggers initial change detection", () => {
  const prev = makeFingerprint({ claimId: 42 });
  const curr = makeFingerprint({ claimId: 99 });
  const result = detectVsIndexChange(prev, curr);

  assert.equal(result.hasChanged, true);
  assert.equal(result.reason, "initial");
  assert.equal(hasVsChanged(prev, curr), true);
});

// ── updatedAt Change Detection ────────────────────────────────────────────────

test("positive: claim updatedAt timestamp change is detected", () => {
  const prev = makeFingerprint({ updatedAt: 1700000000 });
  const curr = makeFingerprint({ updatedAt: 1700000500 });
  const result = detectVsIndexChange(prev, curr);

  assert.equal(result.hasChanged, true);
  assert.equal(result.reason, "updated_at");
  assert.equal(hasVsChanged(prev, curr), true);
});

test("boundary: updatedAt transitioning from null to numeric timestamp is detected", () => {
  const prev = makeFingerprint({ updatedAt: null });
  const curr = makeFingerprint({ updatedAt: 1700001000 });
  const result = detectVsIndexChange(prev, curr);

  assert.equal(result.hasChanged, true);
  assert.equal(result.reason, "updated_at");
  assert.equal(hasVsChanged(prev, curr), true);
});

test("boundary: updatedAt transitioning from timestamp to null is detected", () => {
  const prev = makeFingerprint({ updatedAt: 1700001000 });
  const curr = makeFingerprint({ updatedAt: null });
  const result = detectVsIndexChange(prev, curr);

  assert.equal(result.hasChanged, true);
  assert.equal(result.reason, "updated_at");
  assert.equal(hasVsChanged(prev, curr), true);
});

// ── Reasoning Count Change Detection ──────────────────────────────────────────

test("positive: new reasoning event incrementing count is detected", () => {
  const prev = makeFingerprint({ reasoningCount: 2 });
  const curr = makeFingerprint({ reasoningCount: 3 });
  const result = detectVsIndexChange(prev, curr);

  assert.equal(result.hasChanged, true);
  assert.equal(result.reason, "reasoning_count");
  assert.equal(hasVsChanged(prev, curr), true);
});

test("positive: tombstoned/withheld reasoning event decrementing count is detected", () => {
  const prev = makeFingerprint({ reasoningCount: 3 });
  const curr = makeFingerprint({ reasoningCount: 2 });
  const result = detectVsIndexChange(prev, curr);

  assert.equal(result.hasChanged, true);
  assert.equal(result.reason, "reasoning_count");
  assert.equal(hasVsChanged(prev, curr), true);
});

test("boundary: reasoning count zero boundary is handled correctly", () => {
  const prev = makeFingerprint({ reasoningCount: 0 });
  const curr = makeFingerprint({ reasoningCount: 1 });
  const result = detectVsIndexChange(prev, curr);

  assert.equal(result.hasChanged, true);
  assert.equal(result.reason, "reasoning_count");
  assert.equal(hasVsChanged(prev, curr), true);
});

// ── No Change Detection ───────────────────────────────────────────────────────

test("negative: identical fingerprints produce hasChanged = false", () => {
  const prev = makeFingerprint({ updatedAt: 1700000000, reasoningCount: 4 });
  const curr = makeFingerprint({ updatedAt: 1700000000, reasoningCount: 4 });
  const result = detectVsIndexChange(prev, curr);

  assert.equal(result.hasChanged, false);
  assert.equal(result.reason, undefined);
  assert.equal(hasVsChanged(prev, curr), false);
});

test("negative: both null updatedAt with identical reasoning count produce hasChanged = false", () => {
  const prev = makeFingerprint({ updatedAt: null, reasoningCount: 0 });
  const curr = makeFingerprint({ updatedAt: null, reasoningCount: 0 });
  const result = detectVsIndexChange(prev, curr);

  assert.equal(result.hasChanged, false);
  assert.equal(hasVsChanged(prev, curr), false);
});

// ── Multiple Concurrent Changes ───────────────────────────────────────────────

test("positive: when both updatedAt and reasoningCount change, a change is detected", () => {
  const prev = makeFingerprint({ updatedAt: 1700000000, reasoningCount: 1 });
  const curr = makeFingerprint({ updatedAt: 1700000050, reasoningCount: 2 });
  const result = detectVsIndexChange(prev, curr);

  assert.equal(result.hasChanged, true);
  assert.ok(result.reason === "updated_at" || result.reason === "reasoning_count");
  assert.equal(hasVsChanged(prev, curr), true);
});

// ── SSE Formatting Helpers ────────────────────────────────────────────────────

test("positive: formatSseEvent formats event name and JSON data terminated with double newline", () => {
  const formatted = formatSseEvent("message", { type: "change", claimId: 42 });
  assert.equal(
    formatted,
    'event: message\ndata: {"type":"change","claimId":42}\n\n'
  );
});

test("positive: formatSseData formats JSON data terminated with double newline", () => {
  const formatted = formatSseData({ status: "ok" });
  assert.equal(formatted, 'data: {"status":"ok"}\n\n');
});

test("positive: formatSseComment formats comment line terminated with double newline", () => {
  const formatted = formatSseComment("heartbeat");
  assert.equal(formatted, ": heartbeat\n\n");
});

test("positive: formatSseRetry formats retry interval line terminated with double newline", () => {
  const formatted = formatSseRetry(2000);
  assert.equal(formatted, "retry: 2000\n\n");
});
