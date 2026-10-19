"use client";

import type { CreateVsState } from "../../../hooks/useCreateVsForm";

export interface ReviewSignStepProps {
  state: CreateVsState;
  onPrev: () => void;
  onSubmit: () => void;
  /** True while the wallet is signing or the tx x is in flight. */
  busy?: boolean;
}

const STATUS_LABEL: Record<CreateVsState["submitStatus"], string> = {
  idle: "Ready",
  signing: "Waiting for wallet signature…",
  funding: "Funding the market…",
  submitting: "Submitting transaction…",
  success: "Market created",
  error: "Submission failed",
};

export default function ReviewSignStep({
  state,
  onPrev,
  onSubmit,
  busy = false,
}: ReviewSignStepProps) {
  if (state.submitStatus === "success") {
    return (
      <section aria-labelled="success-step" className="space-y-4">
        <h2 className="text-lg font-semibold">Market created</h2>
        <p className="text-sm text-muted-foreground">
          Your question is now on the book. People can trade it immediately.
        </p>
        {state.createdTxHash ? (
          <p className="break-all font-mono text-xs text-muted-foreground">
            Tx: {state.createdTxHash}
          </p>
        ) : null}
      </section>
    );
  }

  return (
    <section aria-labelled="review-step" className="space-y-4">
      <h2 className="text-lg font-semibold">Review &amp; sign</h2>
      <dl className="space-y-2 text-sm">
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">Question</dt>
          <dd className="max-w-[70%] text-right">{state.question || "—"}</dd>
        </div>
        {state.sides.map((side) => (
          <div key={side.id} className="flex justify-between gap-4">
            <dt className="text-muted-foreground">{side.label}</dt>
            <dd className="text-right">{side.odds}%</dd>
          </div>
        ))}
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">Resolution URL</dt>
          <dd className="break-all text-right font-mono text-xs">
            {state.resolution.url || "—"}
          </dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">Stake</dt>
          <dd className="text-right">{state.stake} tokens</dd>
        </div>
      </dl>

      <p className="text-sm text-muted-foreground">
        Status: {STATUS_LABEL[state.submitStatus]}
      </p>
      {state.submitError ? (
        <p role="alert" className="text-sm text-red-600">
          {state.submitError}
        </p>
      ) : null}

      <div className="flex justify-between">
        <button
          type="button"
          onClick={onPrev}
          disabled={busy}
          className="rounded-md border border-input px-4 py-2 text-sm font-medium disabled:opacity-50"
        >
          Back
        </button>
        <button
          type="button"
          onClick={onSubmit}
          disabled={busy}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {busy ? "Submitting…" : "Sign & create"}
        </button>
      </div>
    </section>
  );
}
