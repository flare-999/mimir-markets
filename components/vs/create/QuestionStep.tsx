"use client";

import type { ChangeEvent } from "react";

export interface QuestionStepProps {
  value: string;
  onChange: (value: string) => void;
  onNext: () => void;
  /** Error message from the shared validation module, or null. */
  error?: string | null;
}

export default function QuestionStep({
  value,
  onChange,
  onNext,
  error = null,
}: QuestionStepProps) {
  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    onChange(event.target.value);
  };

  return (
    <section aria-labelled="question-step" className="space-y-4">
      <h2 className="text-lg font-semibold">Question</h2>
      <p className="text-sm text-muted-foreground">
        Write the question the market resolves. It must be answerable with a
        number read from a single URL.
      </p>
      <label className="block text-sm font-medium" htmlFor="create-vs-question">
        Question
      </label>
      <input
        id="create-vs-question"
        name="question"
        type="text"
        value={value}
        onChange={handleChange}
        placeholder="Will the price of BTC exceed $100,000 on Dec 31, 2025?"
        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? "create-vs-question-error" : undefined}
      />
      {error ? (
        <p id="create-vs-question-error" role="alert" className="text-sm text-red-600">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end">
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
