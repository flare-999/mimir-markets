"use client";

import { useCallback, useRef, type ReactNode } from "react";
import { MARKET_CARD_GRID_ATTR } from "@/lib/market-card-keyboard";
import { useMarketCardGridKeyboard } from "@/hooks/useMarketCardGridKeyboard";

interface MarketCardGridProps {
  children: ReactNode;
  className?: string;
  /** Explicit column count for arrow-up/down; omit to infer from CSS grid. */
  columns?: number;
  /** Accessible name for the card list region. */
  "aria-label"?: string;
}

/**
 * Grid wrapper that enables arrow-key navigation between market cards.
 * Includes a keyboard-shortcuts help disclosure opened by "?".
 */
export default function MarketCardGrid({
  children,
  className = "",
  columns,
  "aria-label": ariaLabel = "Market cards",
}: MarketCardGridProps) {
  const ref = useRef<HTMLDiv>Element>(null);
  const helpRef = useRef<HTMLDetailsElement>(null);

  const openHelp = useCallback(() => {
    const details = helpRef.current;
    if (!details) return;
    details.open = true;
    const summary = details.querySelector<HTMLElement>("summary");
    summary?.focus();
  }, []);

  useMarketCardGridKeyboard(ref, { columns, onOpenHelp: openHelp });

  return (
    <div
      ref={ref}
      role="group"
      aria-label={ariaLabel}
      className={className}
      {...{ [MARKET_CARD_GRID_ATTR]: "true" }}
    >
      {children}
      <details
        ref={helpRef}
        className="mt-4 rounded-border border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
      >
        <summary className="cursor-pointer font-medium focus:outline-none focus:ring-2 focus:ring-sky-500">
          Keyboard shortcuts
        </summary>
        <ul className="mt-2 space-y-1 pl-5 list-disc">
          <li>
            <kbd>Arrow keys</kbd> — move between market cards
          </li>
          <li>
            <kbd>Home</kbd> / <kbd>End</kbd> — jump to the first / last card
          </li>
          <li>
            <kbd>Enter</kbd> / <kbd>Space</kbd> — open the focused card
          </li>
          <li>
            <kbd>?</kbd> — toggle this keyboard shortcuts help
          </li>
        </ul>
      </details>
    </div>
  );
}
