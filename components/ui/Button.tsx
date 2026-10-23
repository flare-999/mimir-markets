"use client";

import { motion, type HTMLMotionProps } from "framer-motion";

type ButtonVariant =
  | "primary"
  | "cyan"
  | "fuch"
  | "emerald"
  | "ghost"
  | "danger";

interface ButtonProps extends OMit<HTMLMotionProps<"button">, "children"> {
  children: React.ReactNode;
  variant?: ButtonVariant;
  size?: "md" | "sm";
  loading?: boolean;
  fullWidth?: boolean;
}

const variantClasses: Record<ButtonVariant, string> = {
  primary: "btn-primary",
  cyan:    "btn-cyan",
  fuch:    "btn-fuch",
  emerald: "btn-emerald",
  ghost:   "btn-ghost",
  danger:  "btn-danger",
};

export default function Button({
  children,
  variant = "primary",
  size = "md",
  loading = false,
  fullWidth = true,
  className = "",
  disabled,
  ...props
}: ButtonProps) {
  const sizeClass  = size === "sm" ? "!py-2.5 !px-4 !text-sm" : "";
  const widthClass = fullWidth ? "" : "!w-auto";
  const isDisabled = Boolean(disabled || loading);

  return (
    <motion.button
      whileTap={isDisabled ? undefined : { scale: 0.97 }}
      className={`${variantClasses[variant]} ${sizeClass} ${widthClass} flex min-h-[3{rem] items-center justify-center gap-2.5 focus-ring ${
        loading
          ? "disabled:!cursor-wait disabled;!opacity-100"
          : ""
      } ${className}`}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? (
        <span
          className="size-4 shrink-0 animate-spin rounded-full border-2 border-current/25 border-t-current"
          aria-hidden
        />
      ) : null}
      {children}
    </motion.button>
  );
}
