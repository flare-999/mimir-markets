/**
 * Tests for GET /api/cron/nonce-prune route.
 *
 * Covers:
 *  - Refusal when bearer token is missing or unauthorized
 *  - Successful nonce pruning with 200 { pruned, at } and Cache-Control: no-store
 *  - Machine-readable 500 internal_error when pruning throws, keeping Cache-Control: no-store
 *    and not echoing raw exception text
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { NextRequest } from "next/server";

const CRON_SECRET = "test-cron-secret-value";
process.env.CRON_SECRET = CRON_SECRET;

import { GET, setPruneNoncesForTesting } from "../../app/api/cron/nonce-prune/route";

function request(url: string, method = "GET", token?: string | null): NextRequest {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== null && token !== undefined) {
    headers.authorization = `Bearer ${token}`;
  }
  return new Request(url, { method, headers }) as unknown as NextRequest;
}

test("GET /api/cron/nonce-prune: refuses a request with no Authorization header", async () => {
  const res = await GET(request("http://localhost/api/cron/nonce-prune", "GET", null));
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.error?.code, "unauthenticated");
});

test("GET /api/cron/nonce-prune: refuses an arbitrary bearer token", async () => {
  const res = await GET(request("http://localhost/api/cron/nonce-prune", "GET", "invalid-secret"));
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.error?.code, "unauthenticated");
});

test("GET /api/cron/nonce-prune: fails closed when CRON_SECRET is unset", async () => {
  const previous = process.env.CRON_SECRET;
  delete process.env.CRON_SECRET;
  try {
    const res = await GET(request("http://localhost/api/cron/nonce-prune", "GET", CRON_SECRET));
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error?.code, "forbidden");
  } finally {
    process.env.CRON_SECRET = previous;
  }
});

test("GET /api/cron/nonce-prune: serves the cron prune to the worker secret", async () => {
  const res = await GET(request("http://localhost/api/cron/nonce-prune", "GET", CRON_SECRET));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const body = await res.json();
  assert.ok("pruned" in body, "response must include pruned count");
  assert.ok("at" in body, "response must include timestamp at");
  assert.equal(typeof body.at, "number");
});

test("GET /api/cron/nonce-prune: returns 500 with machine-readable internal_error when prune throws", async () => {
  const rawErrorMessage = "database connection failure: host unreachable [0xDEAD]";
  setPruneNoncesForTesting(async () => {
    throw new Error(rawErrorMessage);
  });

  try {
    const res = await GET(request("http://localhost/api/cron/nonce-prune", "GET", CRON_SECRET));
    assert.equal(res.status, 500);
    assert.equal(res.headers.get("cache-control"), "no-store");

    const body = await res.json();
    assert.equal(body.error?.code, "internal_error");
    assert.equal(body.error?.retryable, true);
    assert.equal(body.detail, undefined, "detail field must not be present");

    const serialized = JSON.stringify(body);
    assert.ok(
      !serialized.includes(rawErrorMessage),
      "raw exception text must not be echoed in response",
    );
  } finally {
    setPruneNoncesForTesting(null);
  }
});

test("GET /api/cron/nonce-prune: returns 500 internal_error when prune throws via injected deps", async () => {
  const rawErrorMessage = "custom prune dependency failure";
  const res = await GET(
    request("http://localhost/api/cron/nonce-prune", "GET", CRON_SECRET),
    {
      pruneNonces: async () => {
        throw new Error(rawErrorMessage);
      },
    },
  );
  assert.equal(res.status, 500);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const body = await res.json();
  assert.equal(body.error?.code, "internal_error");
  assert.equal(body.error?.retryable, true);
  assert.ok(!JSON.stringify(body).includes(rawErrorMessage));
});
