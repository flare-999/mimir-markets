/**
 * lib/vs-events.ts
 *
 * Types, constants, and pure change-detection helpers for market detail SSE events.
 * Framework-free so it can be imported both on client/server and tested in node:test.
 */

export interface VsIndexFingerprint {
  claimId: number;
  updatedAt: number | null;
  reasoningCount: number;
}

export type VsChangeReason = "initial" | "updated_at" | "reasoning_count";

export interface VsChangeEvent {
  type: "change" | "initial";
  claimId: number;
  updatedAt: number | null;
  reasoningCount: number;
  reason?: VsChangeReason;
}

export interface VsChangeDetectionResult {
  hasChanged: boolean;
  reason?: VsChangeReason;
  previous: VsIndexFingerprint | null;
  current: VsIndexFingerprint;
}

/**
 * Serverless SSE and polling timing constants.
 */
export const SSE_POLL_INTERVAL_MS = 2_000;
export const SSE_HEARTBEAT_INTERVAL_MS = 15_000;
export const SSE_MAX_DURATION_MS = 45_000;
export const SSE_RETRY_MS = 2_000;

/**
 * Pure change-detection helper for VS index polling.
 *
 * Compares two snapshots of a claim's index state (updated_at timestamp and
 * non-withheld reasoning count). Emits whether a change was detected and the reason.
 */
export function detectVsIndexChange(
  previous: VsIndexFingerprint | null,
  current: VsIndexFingerprint
): VsChangeDetectionResult {
  if (previous === null) {
    return {
      hasChanged: true,
      reason: "initial",
      previous: null,
      current,
    };
  }

  if (previous.claimId !== current.claimId) {
    return {
      hasChanged: true,
      reason: "initial",
      previous,
      current,
    };
  }

  if (previous.updatedAt !== current.updatedAt) {
    return {
      hasChanged: true,
      reason: "updated_at",
      previous,
      current,
    };
  }

  if (previous.reasoningCount !== current.reasoningCount) {
    return {
      hasChanged: true,
      reason: "reasoning_count",
      previous,
      current,
    };
  }

  return {
    hasChanged: false,
    previous,
    current,
  };
}

/**
 * Convenience predicate returning true if the index fingerprint changed.
 */
export function hasVsChanged(
  previous: VsIndexFingerprint | null,
  current: VsIndexFingerprint
): boolean {
  return detectVsIndexChange(previous, current).hasChanged;
}

/**
 * Formats a named Server-Sent Event with JSON data.
 */
export function formatSseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Formats a default Server-Sent Event message with JSON data.
 */
export function formatSseData(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

/**
 * Formats an SSE comment line (used for keep-alive heartbeats).
 */
export function formatSseComment(comment: string): string {
  return `: ${comment}\n\n`;
}

/**
 * Formats an SSE reconnection delay instruction in milliseconds.
 */
export function formatSseRetry(retryMs: number): string {
  return `retry: ${retryMs}\n\n`;
}
