/**
 * Settlement retry policy shared by the oracle worker and Stellar call boundary.
 *
 * This module is deliberately pure. Soroban remains the source of truth: a
 * retry is only permitted for a dependency failure, and the worker re-reads the
 * claim before every attempt. Lifecycle errors are terminal observations, not
 * invitations to submit the same funded call again.
 *
 * Error classes:
 *   malformed          bad verdict / invalid contract input; never retry
 *   stale              the snapshot is no longer settleable; refresh chain state
 *   duplicate          the chain already resolved the claim; treat as success
 *   cancelled          the chain cancelled the claim; stop without a write
 *   paused             operator pause; defer without spending or signing
 *   dependency-failure RPC / submission / timeout failure; bounded retry
 */

export const SETTLEMENT_ERROR_CLASSES = [
  "malformed",
  "stale",
  "duplicate",
  "cancelled",
  "paused",
  "dependency-failure",
] as const;

export type SettlementErrorClass = (typeof SETTLEMENT_ERROR_CLASSES)[number];

export type SettlementRetryAction =
  | "retry"
  | "refresh"
  | "defer"
  | "skip"
  | "abort";

export interface SettlementErrorInfo {
  kind: SettlementErrorClass;
  /** Safe, bounded detail for worker logs. Never contains a secret seed. */
  detail: string;
  /** A hash is safe to retain for reconciliation when the RPC returned one. */
  txHash?: string;
  /** True when an error may have happened after submission. */
  submissionUncertain: boolean;
}

export interface SettlementRetryConfig {
  /** Total attempts, including the first submission. */
  maxAttempts: number;
  /** Delay before the first retry. */
  baseDelayMs: number;
  /** Upper bound for exponential backoff. */
  maxDelayMs: number;
}

/**
 * Error raised at the contract boundary with the transaction identity retained.
 *
 * The generated Soroban client may return a hash and a failed/unknown result
 * before throwing. Losing that hash makes an operator unable to reconcile an
 * ambiguous submission and encourages unsafe blind retries.
 */
export class StellarTransactionError extends Error {
  readonly txHash?: string;
  readonly phase: "assemble" | "submit" | "result";
  readonly response?: unknown;

  constructor(
    message: string,
    opts: {
      txHash?: string;
      phase: "assemble" | "submit" | "result";
      response?: unknown;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = "StellarTransactionError";
    this.txHash = opts.txHash;
    this.phase = opts.phase;
    this.response = opts.response;
    if (opts.cause !== undefined) {
      Object.defineProperty(this, "cause", { value: opts.cause, enumerable: false });
    }
  }
}

export function wrapStellarTransactionError(
  error: unknown,
  opts: {
    label: string;
    txHash?: string;
    phase: "assemble" | "submit" | "result";
    response?: unknown;
  },
): StellarTransactionError {
  if (error instanceof StellarTransactionError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new StellarTransactionError(`${opts.label}: ${message}`, {
    txHash: opts.txHash,
    phase: opts.phase,
    response: opts.response,
    cause: error,
  });
}

export interface SettlementRetryConfigResult {
  config: SettlementRetryConfig;
  /** Invalid values are reported for startup logs instead of silently hiding a bad deployment. */
  warnings: string[];
}

export interface SettlementRetryDecision {
  action: SettlementRetryAction;
  attempt: number;
  delayMs: number;
  reason: string;
}

export const DEFAULT_SETTLEMENT_RETRY_CONFIG: SettlementRetryConfig = {
  maxAttempts: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 15_000,
};

const MAX_SETTLEMENT_ATTEMPTS = 5;
const MAX_SETTLEMENT_DELAY_MS = 5 * 60_000;

function boundedString(value: unknown, max = 280): string {
  const text = value instanceof Error ? value.message : String(value ?? "unknown");
  // Seeds and bearer-like values must not end up in heartbeat/log output. This
  // is intentionally conservative; Stellar tx hashes are lowercase hex and do
  // not match these patterns.
  return text
    .replace(/S[A-Z2-7]{20,}/g, "[redacted-stellar-secret]")
    .replace(/(api[_-]?key|authorization|bearer)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .slice(0, max);
}

function nestedText(error: unknown, seen = new Set<unknown>()): string {
  if (error === null || error === undefined) return "unknown";
  if (typeof error === "string") return error;
  if (typeof error !== "object") return String(error);
  if (seen.has(error)) return "unknown";
  seen.add(error);

  const record = error as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ["message", "code", "status", "reason", "error", "result"]) {
    const value = record[key];
    if (value !== undefined && value !== null) {
      parts.push(typeof value === "string" || typeof value === "number" ? String(value) : nestedText(value, seen));
    }
  }
  if (record.cause !== undefined) parts.push(nestedText(record.cause, seen));
  return parts.filter(Boolean).join(" ") || "unknown";
}

function numericContractCode(error: unknown): number | null {
  const record = error && typeof error === "object" ? (error as Record<string, unknown>) : null;
  for (const key of ["code", "errorCode"]) {
    const value = record?.[key];
    if (typeof value === "number" && Number.isInteger(value)) return value;
    if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value);
  }
  const text = nestedText(error);
  const match = text.match(/(?:error|contract|code|err)[^0-9]{0,16}(?:#\s*)?(\d{1,3})\b/i) ?? text.match(/#\s*(\d{1,3})\b/);
  return match ? Number(match[1]) : null;
}

function txHashFrom(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const record = error as Record<string, unknown>;
  for (const key of ["txHash", "transactionHash", "hash"]) {
    const value = record[key];
    if (typeof value === "string" && /^[0-9a-f]{20,128}$/i.test(value)) return value;
  }
  return undefined;
}

/**
 * Classify a raw LLM, Soroban, RPC, or operational error.
 *
 * Unknown errors fail closed as dependency failures. They are retried only a
 * bounded number of times and never converted into a verdict or payout.
 */
export function classifySettlementError(error: unknown): SettlementErrorInfo {
  const text = nestedText(error);
  const normalized = text.toLowerCase();
  const code = numericContractCode(error);
  const txHash = txHashFrom(error);

  // Explicit operator pause and API pause responses are checked first. A pause
  // is not an RPC outage and must not be hidden by a generic retry log.
  if (
    /(?:oracle[_ -]?settlement|agent[_ -]?paused|capability[_ -]?paused|settlement[_ -]?paused)/i.test(normalized) ||
    /mimir_pause[_ -]?oracle[_ -]?settlement/i.test(normalized)
  ) {
    return { kind: "paused", detail: boundedString(text), txHash, submissionUncertain: false };
  }

  // These are chain-terminal observations. They are safe to stop on even when
  // the submitting RPC timed out: the next authoritative read decides whether
  // the transaction actually landed.
  if (
    /cancel(?:led|ed)|claimcancelled|claim is cancelled/i.test(normalized)
  ) {
    return { kind: "cancelled", detail: boundedString(text), txHash, submissionUncertain: Boolean(txHash) };
  }
  if (
    /already\s+(?:resolved|settled|claimed)|duplicate|double[_ -]?settle|claimresolved/i.test(normalized)
  ) {
    return { kind: "duplicate", detail: boundedString(text), txHash, submissionUncertain: Boolean(txHash) };
  }

  // Soroban mimir-market codes: ClaimNotFound=12, ClaimNotActive=21,
  // NotYetExpired=22. All mean the prepared snapshot is not safe to submit;
  // the worker must re-read rather than retrying the same envelope.
  if (
    code === 12 || code === 21 || code === 22 ||
    /claimnotfound|claimnotactive|notyetexpired|not yet expired|deadline.*future|too early|stale/i.test(normalized)
  ) {
    return { kind: "stale", detail: boundedString(text), txHash, submissionUncertain: Boolean(txHash) };
  }

  // LLM parser and contract input failures are deterministic for this payload.
  // In particular, never turn malformed JSON into UNRESOLVABLE: that would make
  // a parser outage a funded refund.
  if (
    /invalid[-_ ]json|missing[-_ ]verdict|invalid[-_ ]verdict|unparseable|malformed|invalid(?:confidence|verdict|input)|invalid url|unsupported url|refused to fetch|ssrf|notoracle|bad[_ -]?auth|auth(?:entication)? failed|unauthori[sz]ed|forbidden|invalid signature|wrong[_ -]?token|payout exceed/i.test(normalized) ||
    code === 4 || code === 23 || code === 37 || code === 27
  ) {
    return { kind: "malformed", detail: boundedString(text), txHash, submissionUncertain: Boolean(txHash) };
  }

  // Transport, rate limit, sequence, simulation and server failures are
  // dependency failures. A missing/unknown error is included intentionally:
  // retry is bounded and the next chain read remains authoritative.
  return {
    kind: "dependency-failure",
    detail: boundedString(text),
    txHash,
    submissionUncertain: Boolean(txHash) || /submit|send|timeout|not found|rpc|network|simulation/i.test(normalized),
  };
}

/**
 * Decide what the worker does with a classified error. Lifecycle classes never
 * retry the funded call. Dependency failures retry with bounded exponential
 * backoff; once exhausted they defer to the next poll.
 */
export function settlementRetryDecision(
  info: SettlementErrorInfo,
  attempt: number,
  config: SettlementRetryConfig = DEFAULT_SETTLEMENT_RETRY_CONFIG,
): SettlementRetryDecision {
  const safeAttempt = Math.max(1, Math.trunc(attempt));
  const delayMs = Math.min(
    Math.max(0, config.maxDelayMs),
    Math.max(0, config.baseDelayMs) * Math.pow(2, safeAttempt - 1),
  );

  switch (info.kind) {
    case "dependency-failure":
      if (safeAttempt < config.maxAttempts) {
        return {
          action: "retry",
          attempt: safeAttempt,
          delayMs,
          reason: `dependency failure; bounded retry ${safeAttempt + 1}/${config.maxAttempts}`,
        };
      }
      return {
        action: "defer",
        attempt: safeAttempt,
        delayMs: 0,
        reason: `dependency failure; retry budget exhausted after ${config.maxAttempts} attempt(s)`,
      };
    case "stale":
      return { action: "refresh", attempt: safeAttempt, delayMs: 0, reason: "chain state changed; refresh before any write" };
    case "duplicate":
      return { action: "skip", attempt: safeAttempt, delayMs: 0, reason: "claim already resolved on chain" };
    case "cancelled":
      return { action: "skip", attempt: safeAttempt, delayMs: 0, reason: "claim cancelled on chain" };
    case "paused":
      return { action: "defer", attempt: safeAttempt, delayMs: 0, reason: "oracle settlement is operator-paused" };
    case "malformed":
      return { action: "abort", attempt: safeAttempt, delayMs: 0, reason: "malformed settlement input is not retryable" };
  }
}

function parseBoundedInt(
  env: Record<string, string | undefined>,
  key: string,
  fallback: number,
  min: number,
  max: number,
  warnings: string[],
): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw.trim());
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    warnings.push(`${key} must be an integer in [${min}, ${max}]; using ${fallback}`);
    return fallback;
  }
  return parsed;
}

/** Read and validate worker retry configuration without logging secrets. */
export function readSettlementRetryConfig(
  env: Record<string, string | undefined> = process.env,
): SettlementRetryConfigResult {
  const warnings: string[] = [];
  const maxAttempts = parseBoundedInt(
    env,
    "ORACLE_SETTLEMENT_TX_MAX_ATTEMPTS",
    DEFAULT_SETTLEMENT_RETRY_CONFIG.maxAttempts,
    1,
    MAX_SETTLEMENT_ATTEMPTS,
    warnings,
  );
  const baseDelayMs = parseBoundedInt(
    env,
    "ORACLE_SETTLEMENT_TX_RETRY_BASE_MS",
    DEFAULT_SETTLEMENT_RETRY_CONFIG.baseDelayMs,
    0,
    MAX_SETTLEMENT_DELAY_MS,
    warnings,
  );
  const maxDelayMs = parseBoundedInt(
    env,
    "ORACLE_SETTLEMENT_TX_RETRY_MAX_MS",
    DEFAULT_SETTLEMENT_RETRY_CONFIG.maxDelayMs,
    0,
    MAX_SETTLEMENT_DELAY_MS,
    warnings,
  );

  const effectiveMaxDelayMs = Math.max(baseDelayMs, maxDelayMs);
  if (maxDelayMs < baseDelayMs) {
    warnings.push("ORACLE_SETTLEMENT_TX_RETRY_MAX_MS was below the base delay; clamped to the base delay");
  }
  return {
    config: { maxAttempts, baseDelayMs, maxDelayMs: effectiveMaxDelayMs },
    warnings,
  };
}

/** Alias with a verb that reads naturally at worker startup. */
export const loadSettlementRetryConfig = readSettlementRetryConfig;

/** True when a fresh chain snapshot can be passed to resolve_claim. */
export function settlementSnapshotIsReady(
  snapshot: { state: string; deadline: number },
  nowSecs: number,
): boolean {
  return snapshot.state === "active" && snapshot.deadline <= nowSecs;
}

/** Sleep is injected by the worker in tests; this helper keeps policy pure. */
export function settlementRetryDelay(
  info: SettlementErrorInfo,
  attempt: number,
  config: SettlementRetryConfig = DEFAULT_SETTLEMENT_RETRY_CONFIG,
): number {
  return settlementRetryDecision(info, attempt, config).delayMs;
}
