"use client";

import { useTranslations } from "next-intl";

interface PoolBadgeProps {
  amount: number;
  large?: boolean;
}

export default function PoolBadge({ amount, large = false }: PoolBadgeProps) {
  const t = useTranslations("poolBadge");

  return (
    <div
      className={` inline-flex items-center gap-2 rounded bg-pv-gold/[0.07] border border-pv-gold/[0.2] font-mono font-bold text-pv-gold ${
        large ? "px-6 py-3 text-lg" : "px-4 py-2 text-sm"
      }`}
    >
      {amount}
      <span className="text-pv-gold/60 text-[0.75em]">USDC</span>
      <span className="text-pv-gold/40 text-[0.7em] font-body font-semibold uppercase tracking-wider">
        {t("atStake")}
      </span>
    </div>
  );
}
