"use client";

import type { ReactNode } from "react";

export interface VsChallenger {
  id: string;
  name?: string | null;
  avatarUrl?: string | null;
  amount?: string | number | null;
  side?: "for" | "against" | string | null;
}

export interface VsChallengersCardProps {
  challengers: VsChallenger[];
  title?: ReactNode;
  emptyMessage?: ReactNode;
  className?: string;
  testId?: string;
  onChallengerClick?: (challenger: VsChallenger) => void;
}

function formatAmount(amount: string | number | null | undefined): string | null {
  if (amount === null || amount === undefined || amount === "") {
    return null;
  }
  if (typeof amount === "number") {
    return amount.toLocaleString();
  }
  return amount;
}

function initials(name: string | null | undefined): string {
  if (!name) {
    return "?";
  }
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return "?";
  }
  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase();
  }
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export default function VsChallengersCard({
  challengers,
  title = "Challengers",
  emptyMessage = "No challengers yet.",
  className,
  testId = "vs-challengers-card",
  onChallengerClick,
}: VsChallengersCardProps) {
  return (
    <section
      data-testid={testId}
      className={[
        "rounded-xl border border-solid bg-card text-card-foreground shadow-sm",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="flex items-center justify-between gap-2 border-b border-solid px-4 py-3">
        <h3 className="text-sm font-semibold">{title}</h3>
        <span className="text-xs text-muted-foreground">
          {challengers.length}
        </span>
      </div>

      {challengers.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-muted-foreground">
          {emptyMessage}
        </p>
      ) : (
        <ul className="divide-y divide-solid">
          {challengers.map((challenger) => {
            const amountLabel = formatAmount(challenger.amount);
            const content = (
              <>
                <span
                  className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted text-xs font-medium text-muted-foreground"
                  aria-hidden="true"
                >
                  {challenger.avatarUrl ? (
                    <img
                      src={challenger.avatarUrl}
                      alt=""
                      className="h-8 w-8 object-cover"
                    />
                  ) : (
                    initials(challenger.name)
                  )}
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium">
                    {challenger.name ?? "Unnamed challenger"}
                  </span>
                  {challenger.side ? (
                    <span className="truncate text-xs text-muted-foreground">
                      {challenger.side}
                    </span>
                  ) : null}
                </span>
                {amountLabel ? (
                  <span className="shrink-0 text-sm font-semibold">
                    {amountLabel}
                  </span>
                ) : null}
              </>
            );

            return (
              <li key={challenger.id} className="">
                {onChallengerClick ? (
                  <button
                    type="button"
                    onClick={() => onChallengerClick(challenger)}
                    className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset"
                    data-testid={`vs-challenger-${challenger.id}`}
                  >
                    {content}
                  </button>
                ) : (
                  <div
                    className="flex items-center gap-3 px-4 py-3"
                    data-testid={`vs-challenger-${challenger.id}`}
                  >
                    {content}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
