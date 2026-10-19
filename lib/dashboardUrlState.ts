import { CATEGORIES } from "@/lib/constants";
import {
  normalizeExploreMinStake,
  parseExploreSearchParams,
} from "@/lib/exploreFilters";
import { clampDashboardPage } from "@/lib/dashboardUiPolicy";

const VALID_CATEGORY_IDS = new Set<string>(
  CATEGORIES.map((c) => c.id as string)
);

export type DashboardUrlTab = "all" | "active" | "done";

/**
 * Estado de filtros del dashboard en query (`tab`, `cat`, `min`, `q`, `page`).
 * Orden de lista y filtros rápidos tipo Explore no forman parte del producto dashboard.
 * La página es base 1 y se clampea al rango válido.
 */
export type DashboardFilterUrlState = {
  tab: DashboardUrlTab;
  cat: string;
  minStake: number;
  search: string;
  page: number;
};

export const DEFAULT_DASHBOARD_FILTER_URL_STATE: DashboardFilterUrlState = {
  tab: "all",
  cat: "all",
  minStake: 0,
  search: "",
  page: 1,
};

function parseDashboardCategory(raw: string | null): string {
  const v = (raw ?? "all").trim().toLowerCase();
  if (v === "all") return "all";
  if (v === "clima") return "clima";
  if (VALID_CATEGORY_IDS.has(v)) return v;
  return "all";
}

/**
 * Lee `?tab=&cat=&min=&q=&page=` con validación alineada a la barra del dashboard
 * (incl. categoría legacy `clima` usada en Advanced).
 * `page` acepta cualquier entrada y se normaliza a base 1 con clamp de rango.
 */
export function parseDashboardUrlSearchParams(
  sp: URLSearchParams
): DashboardFilterUrlState {
  const explore = parseExploreSearchParams(sp);
  const tabRaw = (sp.get("tab") ?? "all").toLowerCase();
  const tab: DashboardUrlTab =
    tabRaw === "active" || tabRaw === "done" ? tabRaw : "all";

  return {
    tab,
    cat: parseDashboardCategory(sp.get("cat")),
    minStake: normalizeExploreMinStake(explore.minStake),
    search: explore.search,
    page: clampDashboardPage(sp.get("page")),
  };
}

/** Solo incluye desviaciones respecto a defaults (URLs cortas).
 * `page=1` es el default y no se emite.
 */
export function serializeDashboardUrlState(
  s: DashboardFilterUrlState
): string {
  const p = new URLSearchParams();
  if (s.tab !== "all") p.set("tab", s.tab);
  if (s.cat !== "all") p.set("cat", s.cat);
  if (s.minStake !== 0) p.set("min", String(s.minStake));
  const q = s.search.trim();
  if (q) p.set("q", q);
  const page = clampDashboardPage(s.page);
  if (page !== 1) p.set("page", String(page));
  return p.toString();
}
