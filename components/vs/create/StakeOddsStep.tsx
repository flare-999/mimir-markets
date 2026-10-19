"use client";

import type { ChangeEvent } from "react";

export interface StakeOddsStepProps {
  stake: number;
  onStakeChange: (value: number) => void;
  onPrev: () => void;
  onNext: () => void;
  error?: string | null;
}

export default function StakeOddsStep({
  stake,
  onStakeChange,
  onPrev,
  onNext,
  error = null,
}: StakeOddsStepProps) {
  const handleChange = (event: ChangeEvent<HTMLInputElement>) =>
    onStakeChange(Number(event.target.value));

  return (
    <section aria-labelled="stake-step" className="space-y-4">
      <h2 className="text-lg font-semibold">Stake</h2>
      <p className="text-sm text-muted-foreground">
        How much to fund the market with. This is the initial liquidity and
        sets the size of the pool.
      </p>
      <label className="block text-sm font-medium" htmlFor="create-vs-stake">
        Stake (tokens)
      </label>
      <input
        id="create-vs-stake"
        type="number"
        min={0}
        step="any"
        value={stake}
        onChange={handleChange}
        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        aria-invalid={error ? true : undefined}
      />
      {error ? (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      ) : null}
      <div className="flex justify-between">
        <button
          type="button"
          onClick={onPrev}
          className="rounded-md border border-input px-4 py-2 text-sm font-medium"
        >
          Back
        </button>
        <button
          type="button"
          onClick={onNext}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
        >
          Continue
        </button>
      </div>
    </section>
  );
}
