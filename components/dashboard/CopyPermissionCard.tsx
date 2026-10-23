"use client";

import React, { useEffect, useId, useRef, useState } from "react";
import { formatAtomicUsdc } from "@/lib/usdc";
import { computeCopyUsageFromExecutions, type CopyUsageExecutionRow } from "@/lib/copy-trading";
import type { CopyPermissionFeedbackView, CopyPermissionStatus } from "@/lib/copy-permission-feedback";
import { ShieldAlert, ShieldCheck, Clock, AlertTriangle, Unlink, Activity, RefreshCw } from "lucide-react";

const STATUS_THEME: Record<CopyPermissionStatus, { label: string; tone: string; icon: React.ComponentType<{ className?: string }> }> = {
  ready: { label: "Contract Backed", tone: "border-pv-emerald/40 bg-pv-emerald/10 text-pv-emerald", icon: ShieldCheck },
  loading: { label: "Verifying Contract", tone: "border-pv-gold/40 bg-pv-gold/10 text-pv-gold", icon: Clock },
  invalid: { label: "Constraint Violation", tone: "border-pv-danger/40 bg-pv-danger/10 text-pv-danger", icon: ShieldAlert },
  stale: { label: "Stale Snapshot", tone: "border-amber-400/40 bg-amber-400/10 text-amber-300", icon: RefreshCw },
  disconnected: { label: "Wallet Disconnected", tone: "border-pv-muted/40 bg-pv-surface text-pv-muted", icon: Unlink },
  dependency_failure: { label: "Chain RPC Error", tone: "border-pv-danger/40 bg-pv-danger/10 text-pv-danger", icon: AlertTriangle },
  paused: { label: "Policy Paused", tone: "border-amber-400/40 bg-amber-400/10 text-amber-300", icon: Clock },
  revoked: { label: "Revoked", tone: "border-pv-danger/40 bg-pv-danger/10 text-pv-danger", icon: ShieldAlert },
  expired: { label: "Expired", tone: "border-pv-muted/40 bg-pv-surface text-pv-muted", icon: Clock },
};

export function CopyPermissionCard({
  feedback,
  executions = [],
  onRevoke,
  isRevoking,
}: {
  feedback: CopyPermissionFeedbackView;
  executions?: readonly CopyUsageExecutionRow[];
  onRevoke?: (permissionId: string) => void;
  isRevoking?: boolean;
}) {
  const theme = STATUS_THEME[feedback.status] ?? STATUS_THEME.invalid;
  const Icon = theme.icon;

  const [confirmOpen, setConfirmOpen] = useState(false);
  const confirmTitleId = useId();
  const confirmDescId = useId();

  // Resolve timezone only after mount so SSR markup stays stable and the reset
  // stamps reflect the viewer's zone (mirrors components/LiveDeadline.tsx).
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  let usage: ReturnType<typeof computeCopyUsageFromExecutions> | null = null;
  try {
    usage = computeCopyUsageFromExecutions(executions);
  } catch {
    // A window total beyond display precision: fall back to caps-only rendering.
  }

  const formatReset = (ms: number) =>
    mounted ? new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "";

  const bars = usage && [
    {
      key: "daily",
      label: "Daily",
      usedAtomic: BigInt(usage.dailyUsedAtomic),
      capAtomic: feedback.dailyCapAtomic ? BigInt(feedback.dailyCapAtomic) : null,
      resetAtMs: usage.nextDailyResetAtMs,
    },
    {
      key: "weekly",
      label: "Weekly",
      usedAtomic: BigInt(usage.weeklyUsedAtomic),
      capAtomic: feedback.weeklyCapAtomic ? BigInt(feedback.weeklyCapAtomic) : null,
      resetAtMs: usage.nextWeeklyResetAtMs,
    },
    {
      key: "open",
      label: "Open exposure",
      usedAtomic: BigInt(usage.openExposureAtomic),
      capAtomic: feedback.totalOpenExposureAtomic ? BigInt(feedback.totalOpenExposureAtomic) : null,
      resetAtMs: null,
    },
  ];

  return (
    <section
      role="region"
      aria-label={`Copy trading permission ${feedback.permissionId ?? ""}`}
      className="rounded-2xl border border-pv-ink/10 bg-pv-surface/30 p-5 transition-colors"
    >
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-pv-ink/10 pb-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs font-semibold text-pv-text">
              {feedback.permissionId ? `Permission: ${feedback.permissionId}` : "Copy Permission"}
            </span>
          </div>
          <p className="mt-0.5 text-xs text-pv-muted">
            Follows <span className="font-mono text-pv-text">{feedback.signalAgentId ?? "—"}</span> via{" "}
            <span className="font-mono text-pv-text">{feedback.executionAgentId ?? "—"}</span>
          </p>
        </div>

        <div
          role="status"
          aria-live="polite"
          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-wider ${theme.tone}`}
        >
          <Icon className="h-3 w-3 shrink-0" />
          <span>{theme.label}</span>
        </div>
      </header>

      {/* Contract-backed feedback detail notice */}
      <div
        className="mt-3 rounded-lg border border-pv-ink/10 bg-pv-surface2/40 px-3.5 py-2 text-xs text-pv-muted"
        aria-live="polite"
      >
        <span className="font-medium text-pv-text">Feedback:</span> {feedback.detail}
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4 text-xs">
        <div className="rounded-lg border border-pv-ink/10 p-2.5">
          <div className="font-mono text-[10px] uppercase tracking-wider text-pv-muted">Max Position</div>
          <div className="mt-1 font-mono text-sm font-semibold tabular-nums text-pv-text">
            {feedback.maxPerPositionAtomic ? `${formatAtomicUsdc(feedback.maxPerPositionAtomic)} USDC` : "—"}
          </div>
        </div>

        <div className="rounded-lg border border-pv-ink/10 p-2.5">
          <div className="font-mono text-[10px] uppercase tracking-wider text-pv-muted">Daily Cap</div>
          <div className="mt-1 font-mono text-sm font-semibold tabular-nums text-pv-text">
            {feedback.dailyCapAtomic ? `${formatAtomicUsdc(feedback.dailyCapAtomic)} USDC` : "—"}
          </div>
        </div>

        <div className="rounded-lg border border-pv-ink/10 p-2.5">
          <div className="font-mono text-[10px] uppercase tracking-wider text-pv-muted">On-Chain Allowance</div>
          <div className="mt-1 font-mono text-sm font-semibold tabular-nums text-pv-text">
            {feedback.onchainAllowanceAtomic !== null
              ? `${formatAtomicUsdc(feedback.onchainAllowanceAtomic)} USDC`
              : "Unread"}
          </div>
        </div>

        <div className="rounded-lg border border-pv-ink/10 p-2.5">
          <div className="font-mono text-[10px] uppercase tracking-wider text-pv-muted">Max Realized Loss</div>
          <div className="mt-1 font-mono text-sm font-semibold tabular-nums text-pv-text">
            {feedback.maxRealizedLossAtomic ? `${formatAtomicUsdc(feedback.maxRealizedLossAtomic)} USDC` : "—"}
          </div>
        </div>
      </div>

      {bars && bars.length > 0 && (
        <div className="mt-4 space-y-3">
          {bars.map((bar) => {
            const cap = bar.capAtomic;
            const pct = cap && cap > 0n ? Number((bar.usedAtomic * 100n) / cap) : null;
            const text = cap !== null
              ? `${formatAtomicUsdc(bar.usedAtomic)} of ${formatAtomicUsdc(cap)} USDC used`
              : `${formatAtomicUsdc(bar.usedAtomic)} USDC used`;
            const resetLabel = bar.resetAtMs !== null ? formatReset(bar.resetAtMs) : "";
            return (
              <div key={bar.key}>
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                  <span className="font-mono text-[10px] uppercase tracking-wider text-pv-muted">{bar.label}</span>
                  <span className="font-mono text-xs font-semibold tabular-nums text-pv-text">{text}</span>
                </div>
                <div
                  className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-pv-ink/[0.08]"
                  role="progressbar"
                  aria-label={`${bar.label} copy budget`}
                  aria-valuetext={text}
                  aria-valuenow={pct ?? undefined}
                  aria-valuemin={pct === null ? undefined : 0}
                  aria-valuemax={pct === null ? undefined : 100}
                >
                  <div
                    className="h-full rounded-full bg-pv-cyan"
                    style={{ width: pct === null ? "0%" : `${Math.min(pct, 100)}%` }}
                  />
                </div>
                {bar.resetAtMs !== null && resetLabel && (
                  <time
                    dateTime={new Date(bar.resetAtMs).toISOString()}
                    className="mt-0.5 block font-mono text-[10px] tabular-nums text-pv-muted"
                  >
                    Resets {resetLabel}
                  </time>
                )}
              </div>
            );
          })}
        </div>
      )}

      {onRevoke && feedback.permissionId && !feedback.isRevoked && (
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={() => setConfirmOpen(true)}
            disabled={isRevoking}
            className="rounded border border-pv-danger/40 bg-pv-danger/10 px-3 py-1.5 font-mono text-xs font-semibold text-pv-danger transition-colors hover:bg-pv-danger/20 disabled:opacity-50"
            aria-label={`Revoke copy permission ${feedback.permissionId}`}
          >
            {isRevoking ? "Revoking…" : "Revoke Permission"}
          </button>
        </div>
      )}

      {confirmOpen && feedback.permissionId && (
        <RevokeConfirmDialog
          permissionId={feedback.permissionId}
          titleId={confirmTitleId}
          descId={confirmDescId}
          isRevoking={isRevoking}
          onCancel={() => setConfirmOpen(false)}
          onConfirm={() => {
            setConfirmOpen(false);
            onRevoke?.(feedback.permissionId!);
          }}
        />
      )}
    </section>
  );
}

function RevokeConfirmDialog({
  permissionId,
  titleId,
  descId,
  isRevoking,
  onCancel,
  onConfirm,
}: {
  permissionId: string;
  titleId: string;
  descId: string;
  isRevoking?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    return () => {
      previouslyFocused.current?.focus?.();
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
        return;
      }
      if (event.key !== "Tab") return;
      const root = dialogRef.current;
      if (!root) return;
      const focusable = root.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (event.shiftKey && (active === first || !root.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !root.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        className="w-full max-w-md rounded-2xl border border-pv-ink/10 bg-pv-surface p-5 shadow-xl"
      >
        <h2 id={titleId} className="text-sm font-semibold text-pv-text">
          Revoke copy permission?
        </h2>
        <div id={descId} className="mt-2 space-y-2 text-xs text-pv-muted">
          <p>
            Revoking{" "}
            <span className="font-mono text-pv-text">{permissionId}</span> is owner-signed and stops Mimir from
            executing further copies for this permission.
          </p>
          <p>
            This does <span className="font-semibold text-pv-text">not</span> revoke on-chain spend allowances. Any
            existing token approvals remain in place and must be revoked separately from your wallet.
          </p>
          <p>
            See the{" "}
            <a
              href="/docs/copy-permissions#spend-permissions"
              className="font-medium text-pv-cyan underline underline-offset-2 hover:text-pv-cyan/80"
              target="_blank"
              rel="noreferrer"
            >
              spend-permission explanation
            </a>{" "}
            for details.
          </p>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="rounded border border-pv-ink/10 bg-pv-surface2/40 px-3 py-1.5 font-mono text-xs font-semibold text-pv-text transition-colors hover:bg-pv-surface2/70"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={isRevoking}
            className="rounded border border-pv-danger/40 bg-pv-danger/10 px-3 py-1.5 font-mono text-xs font-semibold text-pv-danger transition-colors hover:bg-pv-danger/20 disabled:opacity-50"
          >
            {isRevoking ? "Revoking…" : "Revoke Permission"}
          </button>
        </div>
      </div>
    </div>
  );
}
