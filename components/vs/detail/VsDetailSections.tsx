"use client";

import type { ReactNode } from "react";

/**
 * Shared section primitives for the VS detail page.
 *
 * This module holds the small, pure presentational building blocks that the
 * individual VS detail section components (components/vs/detail/*.tsx) reuse.
 *
 * It intentionally contains no data fetching and no page-level state; all
 * data comes from `useVsDetail` and is passed down as typed props. This keeps
 * the visual markup and test ids in one place so route behaviour is unchanged.
 */

export interface VsSectionProps {
  children?: ReactNode;
  className?: string;
  title?: ReactNode;
  description?: ReactNode;
  testId?: string;
  action?: ReactNode;
}

function joinClasses(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

/**
 * A generic, titled section wrapper used by every VS detail section.
 */
export function VsDetailSection({
  children,
  className,
  title,
  description,
  testId,
  action,
}: VsSectionProps) {
  return (
    <section
      data-testid={testId}
      className={joinClasses("flex flex-col gap-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm", className)}
    >
      {(title || description || action) && (
        <div className="flex item-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            {title && (
              <h2 className="text-base font-semibold text-slate-900">{title}</h2>
            )}
            {description && (
              <p className="text-sm text-slate-500">{description}</p>
            )}
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export interface VsEmptyStateProps {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  testId?: string;
}

/**
 * Empty-state block shared by the challengers, rematch chain and activity
 * sections.
 */
export function VsEmptyState({ title, description, icon, action, testId }: VsEmptyStateProps) {
  return (
    <div
      data-testid={testId}
      className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-slate-200 bg-slate-50 px-4 py-8"
    >
      {icon && <div className="text-slate-400">{icon}</div>}
      <p className="text-sm font-medium text-slate-700">{title}</p>
      {description && (
        <p className="text-center text-sm text-slate-500">{description}</p>
      )}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export interface VsLoadingSkeletonProps {
  label?: string;
  testId?: string;
}

/**
 * Skeleton placeholder rendered while `useVsDetail` is still loading.
 */
export function VsLoadingSkeleton({ label = "Loading VS details…", testId }: VsLoadingSkeletonProps) {
  return (
    <div
      data-testid={testId}
      role="status"
      aria-live="polite"
      className="flex flex-col gap-4 animate-pulse"
    >
      <span className="sr-only">{label}</span>
      <div className="h-24 w-full rounded-xl bg-slate-200" />
      <div className="h-40 w-full rounded-xl bg-slate-200" />
      <div className="h-40 w-full rounded-xl bg-slate-200" />
    </div>
  );
}

export interface VsErrorStateProps {
  title?: ReactNode;
  message: ReactNode;
  onRetry?: () => void;
  retryLabel?: string;
  testId?: string;
}

/**
 * Error state rendered when `useVsDetail` fails to load the claim.
 */
export function VsErrorState({
  title = "Unable to load this VS",
  message,
  onRetry,
  retryLabel = "Try again",
  testId,
}: VsErrorStateProps) {
  return (
    <div
      data-testid={testId}
      role="alert"
      className="flex flex-col gap-3 rounded-xl border border-red-200 bg-red-50 p-5 text-red-900"
    >
      <p className="text-sm font-semibold">{title}</p>
      <p className="text-sm">{message}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="self-start rounded-md border border-red-300 bg-white px-3 py-1.5 text-sm font-medium text-red-700 transition colors hover:bg-red-100"
        >
          {retryLabel}
        </button>
      )}
    </div>
  );
}

export interface VsBadgeProps {
  children: ReactNode;
  tone?: "neutral" | "info" | "success" | "warning" | "danger";
  testId?: string;
}

const BADGE_TONES: Record<NonNullable<VsBadgeProps["tone"]>, string> = {
  neutral: "border-slate-200 bg-slate-100 text-slate-700",
  info: "border-sky-200 bg-sky-50 text-sky-700",
  success: "border-emerald-200 bg-emerald-50 text-emerald-700",
  warning: "border-amber-200 bg-amber-50 text-amber-700",
  danger: "border-rose-200 bg-rose-50 text-rose-700",
};

/**
 * Small status badge used across the VS detail sections.
 */
export function VsBadge({ children, tone = "neutral", testId }: VsBadgeProps) {
  return (
    <span
      data-testid={testId}
      className={joinClasses(
        "inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide",
        BADGE_TONES[tone],
      )}
    >
      {children}
    </span>
  );
}

export interface VsSectionHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
}

/**
 * Compact header row for sections that do not use the full `VsDetailSection`
 * wrapper (for example the progress bar or the resolve overlay).
 */
export function VsSectionHeader({ title, subtitle, action }: VsSectionHeaderProps) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold text-slate-900">{title}</h2>
        {subtitle && <p className="text-sm text-slate-500">{subtitle}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
