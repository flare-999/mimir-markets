"use client";

import { useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";

export interface VsResolveOverlayProps {
  /** Whether the resolve overlay is currently visible. */
  open: boolean;
  /** The final verdict label to display (e.g. "YES", "NO", "TIE"). */
  verdict: string;
  /** Optional subtitle / explanation shown under the verdict. */
  subtitle?: string;
  /** Display name of the winning side, if any. */
  winnerName?: string;
  /** Duration in ms for the verdict overlay animation. */
  verdictOverlayMs?: number;
  /** Called once the overlay finishes its visible lifetime. */
  onFinished?: () => void;
  /** Optional class Name for the root container. */
  className?: string;
}

const DEFAULT_VERDICT_OVERLAY_MS = 1600;

export default function VsResolveOverlay({
  open,
  verdict,
  subtitle,
  winnerName,
  verdictOverlayMs = DEFAULT_VERDICT_OVERLAY_MS,
  onFinished,
  className,
}: VsResolveOverlayProps) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    timerRef.current = setTimeout(() => {
      onFinished?.();
    }, verdictOverlayMs);
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [open, verdictOverlayMs, onFinished]);

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          data-testid="vs-resolve-overlay"
          className={[
            "fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm",
            className,
          ]
            .filter(Boolean)
            .join(" ")}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.25 }}
        >
          <motion.div
            className="flex max-w-md flex-col items-center gap-4 rounded-2xl bg-background/95 px-8 py-10 text-center shadow-xl"
            initial={{ scale: 0.85, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.9, opacity: 0 }}
            transition={{ type: "spring", stiffness: 260, damping: 22 }}
          >
            <span className="text-sm font-medium uppercase tracking-widest text-muted-foreground">
              Resolved
            </span>
            <span
              data-testid="vs-resolve-verdict"
              className="text-5xl font-black tracking-tight"
            >
              {verdict}
            </span>
            {winnerName ? (
              <span className="text-base font-semibold text-foreground">
                {winnerName} wins
              </span>
            ) : null}
            {subtitle ? (
              <span className="text-sm text-muted-foreground">{subtitle}</span>
            ) : null}
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
