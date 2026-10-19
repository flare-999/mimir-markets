/**
 * Dashboard filter state must round-trip through the URL, and the pagination
 * helpers it relies on must clamp hostile input instead of throwing.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  DASHBOARD_EXPOSURE_MAX_PAGE,
  clampDashboardPage,
  dashboardTotalPages,
  paginateDashboardExposure,
} from "../../lib/dashboardUiPolicy";
import {
  DEFAULT_DASHBOARD_FILTER_URL_STATE,
  parseDashboardUrlSearchParams,
  serializeDashboardUrlState,
} from "../../lib/dashboardUrlState";

test("defaults serialize to an empty query and parse back to defaults", () => {
  assert.equal(serializeDashboardUrlState(DEFAULT_DASHBOARD_FILTER_URL_STATE), "");
  assert.deepEqual(
    parseDashboardUrlSearchParams(new URLSearchParams("")),
    DEFAULT_DASHBOARD_FILTER_URL_STATE,
  );
});

test("a non-default state round-trips through the URL", () => {
  const state = { tab: "active" as const, cat: "crypto", minStake: 0, search: "btc", page: 3 };
  const query = serializeDashboardUrlState(state);
  assert.match(query, /tab=active/);
  assert.match(query, /page=3/);
  assert.deepEqual(parseDashboardUrlSearchParams(new URLSearchParams(query)), state);
});

test("invalid params fall back to defaults", () => {
  const parsed = parseDashboardUrlSearchParams(
    new URLSearchParams("tab=bogus&cat=nope&page=-4"),
  );
  assert.equal(parsed.tab, "all");
  assert.equal(parsed.cat, "all");
  assert.equal(parsed.page, 1);
});

test("known categories are accepted case-insensitively", () => {
  assert.equal(parseDashboardUrlSearchParams(new URLSearchParams("cat=Sports")).cat, "sports");
  assert.equal(parseDashboardUrlSearchParams(new URLSearchParams("cat=clima")).cat, "clima");
});

test("clampDashboardPage bounds", () => {
  assert.equal(clampDashboardPage("abc"), 1);
  assert.equal(clampDashboardPage(0), 1);
  assert.equal(clampDashboardPage(-1), 1);
  assert.equal(clampDashboardPage("2.9"), 2);
  assert.equal(clampDashboardPage(7), 7);
  assert.equal(clampDashboardPage(Number.MAX_SAFE_INTEGER), DASHBOARD_EXPOSURE_MAX_PAGE);
  assert.equal(clampDashboardPage(50, 10), 10);
});

test("pagination clamps to the last page and never mutates input", () => {
  const items = [1, 2, 3, 4, 5, 6, 7];
  const frozen = Object.freeze([...items]);
  assert.equal(dashboardTotalPages(0), 1);
  assert.equal(dashboardTotalPages(7, 5), 2);
  const page = paginateDashboardExposure(frozen, 99, 5);
  assert.deepEqual(page.items, [6, 7]);
  assert.equal(page.page, 2);
  assert.equal(page.fromIndex, 6);
  assert.equal(page.toIndex, 7);
  assert.equal(page.hasNext, false);
  assert.equal(page.hasPrev, true);
  const empty = paginateDashboardExposure([], 1, 5);
  assert.equal(empty.fromIndex, 0);
  assert.equal(empty.totalPages, 1);
});
