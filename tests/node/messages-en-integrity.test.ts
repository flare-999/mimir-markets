/**
 * messages/en.json must stay loadable by next-intl: valid JSON, no U+FFFD
 * replacement characters left behind by an encoding round-trip, and no
 * namespace silently duplicated by a merge.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const EN_PATH = join(process.cwd(), "messages", "en.json");
const raw = readFileSync(EN_PATH, "utf8");

test("messages/en.json parses as JSON", () => {
  assert.doesNotThrow(() => JSON.parse(raw));
});

test("messages/en.json contains no U+FFFD replacement characters", () => {
  assert.equal(raw.includes("�"), false);
});

test("messages/en.json declares each top-level namespace once", () => {
  const names = [...raw.matchAll(/^ {2}"([^"]+)": [{[]/gm)].map((m) => m[1]);
  const seen = new Set<string>();
  const dupes = names.filter((n) => (seen.has(n) ? true : (seen.add(n), false)));
  assert.deepEqual(dupes, []);
});

test("fee and agent-directory namespaces used by components exist", () => {
  const messages = JSON.parse(raw) as Record<string, Record<string, unknown>>;
  assert.equal(typeof messages.fees?.followBasketIsOwn, "string");
  assert.equal(typeof messages.agentDirectory?.emptyStateTitle, "string");
});
