import { Link } from "@/i18n/navigation";

import { AgentAvatarStack } from "@/components/agents/AgentAvatar";
import type { TimeWindow } from "@/lib/agents/performance";
import type { BasketView } from "@/lib/server/basket-directory";

/**
 * A short ranking above the grid.
 *
 * Three rows, not ten: this is a shortcut to the ones worth opening, and a full
 * ranking would just be the grid again with different sorting.
 */
export function BasketLeaderboard({
  title, hint, baskets, window, render,
}: {
  title: string;
  hint: string;
  baskets: BasketView[];
  window: TimeWindow;
  render: (basket: BasketView) => React.ReactNode;
}) {
  if (baskets.length === 0) return null;

  return (
    <div className="border border-pv-ink/[0.12] bg-pv-surface/40 p-4">
      <div className="mb-2.5">
        <h3 className="font-mono text-[10px] uppercase tracking-wider text-pv-emerald">{title}</h3>
        <p className="text-[11px] text-pv-muted">{hint}</p>
      </div>
      <ol className="space-y-1.5">
        {baskets.map((basket, index) => (
          <li key={basket.definition.id}>
            <Link
              href={`/baskets/${basket.definition.id}${window === "all" ? "" : `?window=${window}`}`}
              className="group flex items-center gap-2.5 py-1"
            >
              <span className="w-4 shrink-0 font-mono text-[11px] text-pv-muted">{index + 1}</span>
              <AgentAvatarStack agents={basket.members} size={20} max={3} />
              <span className="min-w-0 flex-1 truncate text-[13px] text-pv-text group-hover:text-pv-emerald">
                {basket.definition.name}
              </span>
              <span className="shrink-0 text-[13px]">{render(basket)}</span>
            </Link>
          </li>
        ))}
      </ol>
    </div>
  );
}
