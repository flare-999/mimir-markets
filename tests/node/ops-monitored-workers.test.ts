/**
 * Every worker started by `npm run workers` must be monitored by the health
 * evaluator, otherwise a dead worker never raises an alarm.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { MONITORED_WORKERS } from "../../lib/ops/health";

test("every worker in the package.json workers script is monitored", () => {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  const scripts = [...pkg.scripts.workers.matchAll(/"npm:([a-z-]+)"/g)].map((m) => m[1]);
  assert.ok(scripts.length > 0, "workers script lists no npm:<worker> entries");
  const monitored = new Set<string>(MONITORED_WORKERS);
  for (const script of scripts) {
    assert.ok(monitored.has(script.replace(/-/g, "_")), `worker "${script}" is not monitored`);
  }
});

test("MONITORED_WORKERS has no duplicates", () => {
  assert.equal(new Set(MONITORED_WORKERS).size, MONITORED_WORKERS.length);
});
