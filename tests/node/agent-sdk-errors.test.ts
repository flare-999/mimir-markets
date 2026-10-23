import assert from "node:assert/strict";
import test from "node:test";

import { MimirAgentClient, MimirAgentError } from "../../sdk/agents";

function makeClient(overrides: Partial<ConstructorParameters<typeof MimirAgentClient>[0]> = {}) {
  return new MimirAgentClient({
    baseUrl: "https://agent.example",
    agentId: "agent-42",
    signMessage: async () => "sig",
    ...overrides,
  });
}

test("400 invalid_request throws MimirAgentError with parsed error fields", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          error: {
            code: "invalid_request",
            message: "Missing required parameter",
            retryable: false,
            field: "body.marketId",
            trace_id: "trace-400-abc",
          },
        }),
        {
          status: 400,
          headers: {
            "content-type": "application/json",
            "x-mimir-trace-id": "trace-400-abc",
          },
        },
      );

    const client = makeClient();
    await assert.rejects(
      () => client.request("heartbeat", {}),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err instanceof MimirAgentError);
        assert.equal(err.name, "MimirAgentError");
        assert.equal(err.status, 400);
        assert.equal(err.code, "invalid_request");
        assert.equal(err.retryable, false);
        assert.equal(err.field, "body.marketId");
        assert.equal(err.traceId, "trace-400-abc");
        assert.equal(err.message, "Missing required parameter");
        assert.equal(err.retryAfterSeconds, undefined);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("429 with retry-after prefers header over body retryAfterSeconds", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          error: {
            code: "rate_limited",
            message: "Too many requests",
            retryable: true,
            retryAfterSeconds: 60,
          },
        }),
        {
          status: 429,
          headers: {
            "content-type": "application/json",
            "retry-after": "15",
          },
        },
      );

    const client = makeClient();
    await assert.rejects(
      () => client.request("heartbeat", {}),
      (err: unknown) => {
        assert.ok(err instanceof MimirAgentError);
        assert.equal(err.status, 429);
        assert.equal(err.code, "rate_limited");
        assert.equal(err.retryable, true);
        assert.equal(err.retryAfterSeconds, 15);
        assert.equal(err.message, "Too many requests");
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("HTML 502 does not throw SyntaxError and maps to upstream_unavailable with retryable true", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response("<html><head><title>502 Bad Gateway</title></head><body>502 Bad Gateway</body></html>", {
        status: 502,
        headers: { "content-type": "text/html" },
      });

    const client = makeClient();
    await assert.rejects(
      () => client.request("heartbeat", {}),
      (err: unknown) => {
        assert.ok(!(err instanceof SyntaxError));
        assert.ok(err instanceof MimirAgentError);
        assert.equal(err.status, 502);
        assert.equal(err.code, "upstream_unavailable");
        assert.equal(err.retryable, true);
        assert.equal(err.retryAfterSeconds, undefined);
        assert.equal(err.field, undefined);
        assert.equal(err.traceId, undefined);
        assert.match(err.message, /502/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("200 returns successful response payload unchanged", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ ok: true, data: "pong" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    const client = makeClient();
    const result = await client.request("heartbeat", {});
    assert.deepEqual(result, { ok: true, data: "pong" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("non-JSON or missing error on 4xx maps to internal_error with retryable false", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response("Plain error message without JSON structure", {
        status: 400,
        headers: { "content-type": "text/plain" },
      });

    const client = makeClient();
    await assert.rejects(
      () => client.request("heartbeat", {}),
      (err: unknown) => {
        assert.ok(err instanceof MimirAgentError);
        assert.equal(err.status, 400);
        assert.equal(err.code, "internal_error");
        assert.equal(err.retryable, false);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("429 without retry-after header falls back to payload retryAfterSeconds", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          error: {
            code: "rate_limited",
            message: "Slow down",
            retryable: true,
            retryAfterSeconds: 45,
          },
        }),
        {
          status: 429,
          headers: { "content-type": "application/json" },
        },
      );

    const client = makeClient();
    await assert.rejects(
      () => client.request("heartbeat", {}),
      (err: unknown) => {
        assert.ok(err instanceof MimirAgentError);
        assert.equal(err.status, 429);
        assert.equal(err.code, "rate_limited");
        assert.equal(err.retryable, true);
        assert.equal(err.retryAfterSeconds, 45);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
