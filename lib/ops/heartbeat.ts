/**
 * Reading and writing the health signals that `lib/ops/health.ts` evaluates.
 *
 * Everything lands in `sync_meta`, a key/value table that already exists. A few
 * rows overwritten in place do not justify a migration, and keeping the store
 * boring means a worker can report without a schema change.
 *
 * Two deliberate ceilings, stated rather than hidden:
 *
 *  - **Counters are read-modify-write, so a concurrent increment can be lost.**
 *    That is acceptable here: a lost increment makes a ratio alarm marginally
 *    late, and the alarm needs twenty samples before it fires at all. Making this
 *    exact would mean a real metrics store; the upgrade path is Prometheus, not a
 *    cleverer UPDATE.
 *  - **A worker that never starts never writes a row.** That is the point: the
 *    evaluator treats a missing row as critical, so a dead worker is loud rather
 *    than absent.
 */

import { getSyncMeta, setSyncMeta, isDbConfigured } from "@/lib/db";

import { pauseEnvKey, pauseState, type Pausable } from "./flags";

import { currentTraceId, endSpan, mintTraceId, runWithTrace, startSpan } from "./trace";

import {
  decodeHeartbeat,
  encodeHeartbeat,
  MONITORED_WORKERS,
  type MonitoredWorker,
  type FailureWindow,
  type WorkerBeat,
} from "./health";

/** Dependencies whose failure rate is tracked. */
export const TRACKED_DEPENDENCIES = ["rpc", "facilitator", "sources"] as const;
export type TrackedDependency = (typeof TRACKED_DEPENDENCIES)[number];

/** Counters roll over hourly so a bad hour cannot poison the ratio forever. */
export const FAILURE_WINDOW_MS = 60 * 60 * 1000;

/** Default hard timeout for a shutdown to finish the in-flight cycle. */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30 * 1000;

function windowKey(dependency: TrackedDependency): string {
  return `failures:${dependency}`;
}

/**
 * Record a heartbeat. `error` marks the worker as alive but failing, which a
 * staleness check alone would report as healthy.
 *
 * Never throws: a worker must not die because its heartbeat could not be
 * written. A swallowed write shows up as staleness, which is exactly the signal
 * an operator wants anyway.
 *
 * The cycle's trace id rides along in the row, so `/api/health` can name the
 * trace to grep for instead of leaving the operator to reconstruct a window.
 */
export async function beat(
  worker: MonitoredWorker,
  opts: { error?: unknown; intervalSec?: number; nowMs?: number } = {},
): Promise<void> {
  if (!isDbConfigured()) return;
  const nowMs = opts.nowMs ?? Date.now();
  const traceId = currentTraceId();
  try {
    await setSyncMeta(
      heartbeatKeyFor(worker),
      encodeHeartbeat({
        atMs: nowMs,
        error: opts.error ? describe(opts.error) : undefined,
        intervalSec: opts.intervalSec,
        ...(traceId ? { traceId } : {}),
      }),
    );
  } catch (err) {
    console.warn(`[ops] heartbeat write failed for ${worker}:`, err);
  }
}

/**
 * Run one worker cycle and report the outcome either way.
 *
 * Swallows the error like the loops it replaces — a worker must keep polling
 * after a bad cycle — but reports it, so a crash-looping worker shows as alive
 * and failing rather than merely stale.
 *
 * `pause` names the incident switch for this worker. A paused worker skips the
 * cycle but keeps running and beating: exiting would trip `npm run workers'
 * --kill-others-on-fail and take every other worker down with it, and a missing
 * heartbeat would page as a dead worker for what is a deliberate stop.
 *
 * Each cycle is one trace. That is the whole correlation contract for a worker:
 * the id is minted here, stamped on this cycle's spans and log lines, attached to
 * the web calls the cycle makes (via `outboundTraceHeaders`), and written into the
 * heartbeat row so `/api/health` can point at it. A cycle is the natural unit —
 * it is what an operator means by "the run that failed" — and it is bounded, so a
 * trace never spans a process lifetime.
 */
export async function reportingPoll(
  worker: MonitoredWorker,
  label: string,
  intervalSec: number,
  poll: () => Promise<unknown>,
  opts: { pause?: Pausable; env?: Record<string, string | undefined> } = {},
): Promise<void> {
  const traceId = mintTraceId();
  await runWithTrace({ traceId, source: "generated", worker }, async () => {
    const span = startSpan(`${worker}.cycle`, {
      attributes: { worker, interval_sec: intervalSec },
    });

    if (opts.pause) {
      const state = pauseState(opts.pause, opts.env);
      if (state.paused) {
        const via = state.viaGlobal ? "MIMIR_PAUSE_ALL" : pauseEnvKey(opts.pause);
        console.warn(
          `[${label}] ${traceId} paused by ${via}, skipping this cycle${state.reason ? `: ${state.reason}` : ""}`,
        );
        // `cancelled`, not `ok`: the cycle produced no work, and a graph that
        // counted a paused cycle as a successful one would hide an incident.
        endSpan(span, { status: "cancelled", attributes: { paused_by: via } });
        await beat(worker, { intervalSec });
        return;
      }
    }

    try {
      await poll();
      endSpan(span, { status: "ok" });
      await beat(worker, { intervalSec });
    } catch (err) {
      console.error(
        `[${label}] ${traceId} poll failed, will retry next interval:`,
        err,
      );
      endSpan(span, { error: err });
      await beat(worker, { error: err, intervalSec });
    }
  });
}

/**
 * Schedule a worker's cycles without overlap and stop cleanly on SIGTERM/SIGINT.
 *
 * Replaces the `await safePoll(); setInterval(safePoll, INTERVAL)` pattern that
 * every worker used to end `main()`. `setInterval` fires on a fixed cadence
 * regardless of whether the previous cycle finished, so a cycle that outlasts the
 * interval (e.g. the oracle waiting out `ORACLE_SETTLEMENT_DELAY_MS`) stacks a
 * second run on top of the first. This loop waits for the current cycle to
 * settle before scheduling the next one, so two cycles of the same worker can
 * never run concurrently.
 *
 * Signal handling: on SIGTERM/SIGINT the loop stops scheduling new cycles but
 * lets the in-flight one finish, then resolves. A hard timeout
 * (`shutdownTimeoutMs`) forces the process to exit if the cycle hangs, so a
 * Railway/concurrently restart cannot wait forever on a stuck transaction.
 *
 * Heartbeats are reported per cycle by the caller's `cycle` function (typically
 * `wrapped in `reportingPoll`), so the beat semantics are unchanged.
 */
export interface RunWorkerLoopOptions {
  /** The monitored worker name, used for logging. */
  worker: MonitoredWorker;
  /** Milliseconds to wait between the end of one cycle and the start of the next. */
  intervalMs: number;
  /** One cycle. Errors are the caller's to swallow (e.g. `reportingPoll` does). */
  cycle: () => Promise<unknown>;
  /** Hard timeout before forcing exit on shutdown. Defaults to 30s. */
  shutdownTimeoutMs?: number;
  /** Override the process object (for tests). */
  process?: Pick<NodeJS.Process, "on" | "off" | "exit"> & Partial<Pick<NodeJS.Process, "on" | "off">>;
  /** Override timers (for tests). */
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  /** Override the exit function (for tests). */
  exit?: (code?: number) => never | void;
  /** Override the console (for tests). */
  log?: Pick<Console, "info" | "warn" | "error">;
}

export async function runWorkerLoop(opts: RunWorkerLoopOptions): Promise<void> {
  const {
    worker,
    intervalMs,
    cycle,
    shutdownTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
    process = globalThis.process,
    setTimeout = globalThis.setTimeout,
    clearTimeout = globalThis.clearTimeout,
    exit = (code?: number) => globalThis.process.exit(code),
    log = console,
  } = opts;

  let sttopping = false;
  let hardTimeout: ReturnType<typeof setTimeout> | null = null;
  let sleepTimer: ReturnType<typeof setTimeout> | null = null;
  let sleepResolve: (() => void) | null = null;

  const onSignal = (signal: NodeJS.Signals) => {
    if (sttopping) return;
    stopping = true;
    log.info(`[${worker}] ${signal} received, finishing current cycle then exiting`);
    // Wake any pending inter-cycle sleep so the loop can observe the flag.
    if (sleepResolve) {
      const resolve = sleepResolve;
      sleepResolve = null;
      if (sleepTimer) {
        clearTimeout(sleepTimer);
        sleepTimer = null;
      }
      resolve();
    }
    // Hard timeout: force exit if the in-flight cycle never settles.
    if (hardTimeout === null) {
      hardTimeout = setTimeout(() => {
        log.warn(`[${worker}] shutdown timeout expired, forcing exit`);
        exit(1);
      }, shutdownTimeoutMs);
      // Do not keep the process alive solely for the timeout.
      if (typeof (hardTimeout as { unref?: () => void }).unref === "function") {
        (hardTimeout as { unref: () => void }).unref();
      }
    }
  };

  const signals: NodeJS.Signals[] = ["SIGTERM", "SIGINT"];
  for (const sig of signals) process.on(sig, onSignal);

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      if (stopping) {
        resolve();
        return;
      }
      sleepResolve = resolve;
      sleepTimer = setTimeout(() => {
        sleepTimer = null;
        sleepResolve = null;
        resolve();
      }, ms);
    });

  try {
    // Run one cycle immediately, then schedule the next only after it finishes.
    while (!stopping) {
      try {
        await cycle();
      } catch (err) {
        // `reportingPoll` already swallows and reports cycle errors; this
        // guard is for a `cycle` that throws outside that wrapper.
        log.error(`[${worker}] cycle threw unexpectedly:`, err);
      }
      if (stopping) break;
      await sleep(intervalMs);
    }
  } finally {
    for (const sig of signals) process.off(sig, onSignal);
    if (hardTimeout !== null) {
      clearTimeout(hardTimeout);
      hardTimeout = null;
    }
    if (sleepTimer !== null) {
      clearTimeout(sleepTimer);
      sleepTimer = null;
    }
  }

  if (stopping) {
    log.info(`[${worker}] stopped cleanly`);
  }
}

function describe(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  // Truncated: this string is rendered in an alarm line, and a stack trace pasted
  // into a pager message buries the alarm it came with.
  return text.slice(0, 200);
}

function heartbeatKeyFor(worker: MonitoredWorker): string {
  return `heartbeat:${worker}`;
}

export async function readWorkerBeats(): Promise<WorkerBeat[]> {
  const beats = await Promise.all(
    MONITORED_WORKERS.map(async (name) => {
      const payload = decodeHeartbeat(await safeGet(heartbeatKeyFor(name)));
      return {
        name,
        lastBeatAtMs: payload?.atMs ?? null,
        lastError: payload?.error,
        expectedIntervalSec: payload?.intervalSec,
        lastTraceId: payload?.traceId,
      } satisfies WorkerBeat;
    }),
  );
  return beats;
}

/**
 * Count one attempt against a dependency.
 *
 * Fire-and-forget by design — an accounting write must never fail the call it is
 * accounting for.
 */
export async function recordOutcome(
  dependency: TrackedDependency,
  ok: boolean,
  nowMs = Date.now(),
): Promise<void> {
  if (!isDbConfigured()) return;
  try {
    const current = parseWindow(await safeGet(windowKey(dependency)));
    const fresh =
      current === null || nowMs - current.startedAtMs >= FAILURE_WINDOW_MS
        ? { startedAtMs: nowMs, attempts: 0, failures: 0 }
        : current;
    await setSyncMeta(
      windowKey(dependency),
      JSON.stringify({
        startedAtMs: fresh.startedAtMs,
        attempts: fresh.attempts + 1,
        failures: fresh.failures + (ok ? 0 : 1),
      }),
    );
  } catch (err) {
    console.warn(`[ops] failure counter write failed for ${dependency}:`, err);
  }
}

interface StoredWindow {
  startedAtMs: number;
  attempts: number;
  failures: number;
}

/** A corrupt or absent row reads as an empty window, which cannot alarm. */
export function parseWindow(raw: string | null): StoredWindow | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredWindow> | null;
    if (!parsed || typeof parsed !== "object") return null;
    const { startedAtMs, attempts, failures } = parsed;
    if (
      typeof startedAtMs !== "number" ||
      typeof attempts !== "number" ||
      typeof failures !== "number" ||
      !Number.isFinite(startedAtMs) ||
      attempts < 0 ||
      failures < 0
    ) {
      return null;
    }
    // A row claiming more failures than attempts is corrupt; clamping keeps the
    // ratio inside [0,1] so a graph does not show 300% failures.
    return { startedAtMs, attempts, failures: Math.min(failures, attempts) };
  } catch {
    return null;
  }
}

/** An expired window reads as empty rather than stale — old data cannot alarm. */
export function windowToFailureWindow(
  stored: StoredWindow | null,
  nowMs: number,
): FailureWindow {
  if (!stored || nowMs - stored.startedAtMs >= FAILURE_WINDOW_MS) {
    return { attempts: 0, failures: 0 };
  }
  return { attempts: stored.attempts, failures: stored.failures };
}

export async function readFailureWindow(
  dependency: TrackedDependency,
  nowMs = Date.now(),
): Promise<FailureWindow> {
  return windowToFailureWindow(parseWindow(await safeGet(windowKey(dependency))), nowMs);
}

/**
 * A read that cannot take the health endpoint down. If the database is
 * unreachable the endpoint still answers, reporting missing heartbeats —"which is
 * the correct alarm for "the database is unreachable" anyway.
 */
async function safeGet(key: string): Promise<string | null> {
  try {
    return await getSyncMeta(key);
  } catch (err) {
    console.warn(`[ops] sync_meta read failed for ${key}:`, err);
    return null;
  }
}
