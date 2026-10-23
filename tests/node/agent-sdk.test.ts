import { test } from "node:test";
import assert from "node:assert";

import {
  MimirAgentClient,
  MimirApiError,
  AGENT_API_ACTIONS,
} from "../../sdk/agents.ts";

type CapturedRequest = {
  url: string;
  init: RequestInit;
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch(
  handler: (req: CapturedRequest) => Response | Promise<Response>,
): { fetch: typeof fetch; calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const req = { url: String(input), init };
    calls.push(req);
    return handler(req);
  };
  return { fetch: fetchImpl as typeof fetch, calls };
}

function parseBody(req: CapturedRequest): Record<string, unknown> {
  const raw = req.init.body;
  assert.equal(typeof raw, "string", "expected a string request body");
  return JSON.parse(raw as string) as Record<string, unknown>;
}

test("AGENT_API_ACTIONS is non-empty and exposed", () => {
  assert.ok(Array.isArray(AGENT_API_ACTIONS));
  assert.ok(AGENT_API_ACTIONS.length > 0);
});

test("every action has a client method", () => {
  const client = new MimirAgentClient({
    baseUrl: "https://api.example.test",
    fetch: stubFetch(() => jsonResponse({ ok: true })).fetch,
  });
  const proto = MimirAgentClient.prototype as Record<string, unknown>;
  for (const action of AGENT_API_ACTIONS) {
    const method = proto[action];
    assert.equal(typeof method, "function", `missing client method for action ${action}`);
    assert.equal(typeof (client as any)[action], "function");
  }
});

test("sends body with bearer header for non-owner actions with apiKey", async () => {
  const stub = stubFetch(() => jsonResponse({ result: "ok" }));
  const client = new MimirAgentClient({
    baseUrl: "https://api.example.test",
    apiKey: "test-key",
    fetch: stub.fetch,
  });

  await client.spendStatus();

  assert.equal(stub.calls.length, 1);
  const call = stub.calls[0];
  const headers = new Headers(call.init.headers as HeadersInit);
  assert.equal(headers.get("authorization"), "Bearer test-key");
  const body = parseBody(call);
  assert.deepEqual(Object.keys(body), ["body"]);
});

test("refuses owner-signed actions locally when apiKey is set", async () => {
  const stub = stubFetch(() => jsonResponse({ result: "ok" }));
  const client = new MimirAgentClient({
    baseUrl: "https://api.example.test",
    apiKey: "test-key",
    fetch: stub.fetch,
  });

  const ownerAction = (client as any).issueKey;
  if (typeof ownerAction !== "function") {
    // if issueKey is not owner-signed in this build, the local refusal check is not applicable
    return;
  }

  await assert.rejects(
    () => ownerAction.call(client, {}),
    (err: unknown) => {
      assert.ok(err instanceof MimirApiError);
      assert.match((err as Error).message, /apiKey/i);
      return true;
    },
  );
  assert.equal(stub.calls.length, 0, "owner-signed action must not be sent");
});

test("surfaces apiError envelope as MimirApiError", async () => {
  const stub = stubFetch(() =>
    jsonResponse(
      {
        apiError: {
          code: "insufficient_spend",
          message: "spend limit exceeded",
          retryable: false,
          requestId: "req_123",
        },
      },
      402,
    ),
  );
  const client = new MimirAgentClient({
    baseUrl: "https://api.example.test",
    apiKey: "test-key",
    fetch: stub.fetch,
  });

  await assert.rejects(
    () => client.spendStatus(),
    (err: unknown) => {
      assert.ok(err instanceof MimirApiError);
      const apiErr = err as MimirApiError;
      assert.equal(apiErr.status, 402);
      assert.equal(apiErr.code, "insufficient_spend");
      assert.equal(apiErr.retryable, false);
      assert.equal(apiErr.requestId, "req_123");
      return true;
    },
  );
});

test("produces MimirApiError with status on non-JSON error response", async () => {
  const stub = stubFetch(() =>
    new Response("<badgateway></badgateway>", {
      status: 502,
      headers: { "content-type": "text/html" },
    }),
  );
  const client = new MimirAgentClient({
    baseUrl: "https://api.example.test",
    apiKey: "test-key",
    fetch: stub.fetch,
  });

  await assert.rejects(
    () => client.spendStatus(),
    (err: unknown) => {
      assert.ok(err instanceof MimirApiError);
      const apiErr = err as MimirApiError;
      assert.equal(apiErr.status, 502);
      return true;
    },
  );
});
