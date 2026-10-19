import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";

import {
  ACCESS_TIERS,
  TIER_POLICIES,
  assertTierCanMutate,
  authorizeRequest,
  isAccessTier,
  type RequestContext,
} from "../../lib/api/policy";
import { resetRateLimits, type LimitRule } from "../../lib/api/rate-limit";

const SECRET = "correct-horse-battery-staple";

/** Generous limits, so a limit only fires in the tests that are about limits. */
const LOOSE: LimitRule[] = [
  { dimension: "ip", limit: 1_000, windowMs: 60_000 },
  { dimension: "wallet", limit: 1_000, windowMs: 60_000 },
  { dimension: "agent", limit: 1_000, windowMs: 60_000 },
  { dimension: "route", limit: 1_000, windowMs: 60_000 },
];

function ctx(overrides: Partial<RequestContext> = {}): RequestContext {
  return { route: "/api/test", ip: "1.2.3.4", ...overrides };
}

beforeEach(() => resetRateLimits());

// ── Public read ───────────────────────────────────────────────────────────────

test("a public read needs nothing but a route", () => {
  const result = authorizeRequest("public_read", ctx(), LOOSE);
  assert.equal(result.allowed, true);
});

test("a public read route cannot be declared as value-moving", () => {
  // Caught where the route is declared, not only when a request arrives.
  assert.throws(() => assertTierCanMutate("public_read"), /cannot move value/);
  for (const tier of ACCESS_TIERS.filter((t) => t !== "public_read")) {
    assert.doesNotThrow(() => assertTierCanMutate(tier));
  }
});

test("an anonymous caller is not bucketed by wallet", () => {
  // Substituting a placeholder would merge every anonymous caller into one bucket.
  assert.equal(TIER_POLICIES.public_read.limitDimensions.includes("wallet"), false);
});

// ── Authenticated user ────────────────────────────────────────────────────────

test("an authenticated route refuses a request with no wallet", () => {
  const result = authorizeRequest("authenticated_user", ctx(), LOOSE);
  assert.equal(result.allowed, false);
  assert.equal(result.error?.body.error.code, "unauthenticated");
  assert.equal(result.error?.status, 401);
});

test("an authenticated route accepts a wallet", () => {
  assert.equal(
    authorizeRequest("authenticated_user", ctx({ wallet: "0xabc" }), LOOSE).allowed,
    true,
  );
});

// ── Registered agent ──────────────────────────────────────────────────────────

test("an agent route refuses an unverified signature", () => {
  const result = authorizeRequest(
    "registered_agent",
    ctx({ wallet: "0xabc", agentId: "agent-1", signatureVerified: false }),
    LOOSE,
  );
  assert.equal(result.error?.body.error.code, "invalid_signature");
});

test("a missing verification result is a refusal, not a pass", () => {
  // undefined means verification never ran — treating that as ok is the classic
  // hole in this kind of check.
  const result = authorizeRequest(
    "registered_agent",
    ctx({ wallet: "0xabc", agentId: "agent-1" }),
    LOOSE,
  );
  assert.equal(result.allowed, false);
  assert.equal(result.error?.body.error.code, "invalid_signature");
});

test("an agent route refuses a verified signature with no agent id", () => {
  const result = authorizeRequest(
    "registered_agent",
    ctx({ wallet: "0xabc", signatureVerified: true }),
    LOOSE,
  );
  assert.equal(result.error?.body.error.code, "unauthenticated");
});

test("an agent route accepts a verified signed request", () => {
  const result = authorizeRequest(
    "registered_agent",
    ctx({ wallet: "0xabc", agentId: "agent-1", signatureVerified: true }),
    LOOSE,
  );
  assert.equal(result.allowed, true);
});

// ── Internal worker ───────────────────────────────────────────────────────────

test("a worker route accepts the configured secret", () => {
  const result = authorizeRequest(
    "internal_worker",
    ctx({ presentedSecret: SECRET, expectedSecret: SECRET }),
    LOOSE,
  );
  assert.equal(result.allowed, true);
});

test("a worker route refuses a wrong secret", () => {
  const result = authorizeRequest(
    "internal_worker",
    ctx({ presentedSecret: "nope", expectedSecret: SECRET }),
    LOOSE,
  );
  assert.equal(result.error?.body.error.code, "unauthenticated");
});

test("an UNSET server secret refuses everything rather than waving it through", () => {
  // A deploy that forgets the secret must fail closed, or the endpoint is open.
  const result = authorizeRequest("internal_worker", ctx({ presentedSecret: "anything" }), LOOSE);
  assert.equal(result.allowed, false);
  assert.equal(result.error?.body.error.code, "forbidden");
  assert.match(result.error?.body.error.message ?? "", /not configured/);
});

test("an empty presented secret is refused even when one is configured", () => {
  const result = authorizeRequest(
    "internal_worker",
    ctx({ presentedSecret: "   ", expectedSecret: SECRET }),
    LOOSE,
  );
  assert.equal(result.error?.body.error.code, "unauthenticated");
});

test("a secret of the wrong length is refused without comparing content", () => {
  const result = authorizeRequest(
    "internal_worker",
    ctx({ presentedSecret: SECRET.slice(0, -1), expectedSecret: SECRET }),
    LOOSE,
  );
  assert.equal(result.allowed, false);
});

test("a worker is not rate-limited by IP", () => {
  // Bucketing a serverless region by IP would limit every worker together.
  assert.equal(TIER_POLICIES.internal_worker.limitDimensions.includes("ip"), false);
});

// ── Idempotency on value-moving calls ─────────────────────────────────────────

test("a value-moving call without an idempotency key is refused", () => {
  // A retried payment without one is a second payment.
  for (const tier of ["authenticated_user", "registered_agent", "internal_worker"] as const) {
    const result = authorizeRequest(
      tier,
      ctx({
        wallet: "0xabc",
        agentId: "agent-1",
        signatureVerified: true,
        presentedSecret: SECRET,
        expectedSecret: SECRET,
        mutatesValue: true,
      }),
      LOOSE,
    );
    assert.equal(result.allowed, false, `${tier} allowed a keyless mutation`);
    assert.equal(result.error?.body.error.code, "invalid_request");
  }
});

test("a blank idempotency key does not count", () => {
  const result = authorizeRequest(
    "authenticated_user",
    ctx({ wallet: "0xabc", mutatesValue: true, idempotencyKey: "  " }),
    LOOSE,
  );
  assert.equal(result.allowed, false);
});

test("a value-moving call with a key passes", () => {
  const result = authorizeRequest(
    "authenticated_user",
    ctx({ wallet: "0xabc", mutatesValue: true, idempotencyKey: "op-1", originValid: true }),
    LOOSE,
  );
  assert.equal(result.allowed, true);
});

test("a read does not need an idempotency key", () => {
  assert.equal(
    authorizeRequest("authenticated_user", ctx({ wallet: "0xabc" }), LOOSE).allowed,
    true,
  );
});

// ── Rate limiting ─────────────────────────────────────────────────────────────

test("the tier's dimensions are the ones enforced", () => {
  // An agent route limits by agent, so a shared IP does not throttle two agents.
  const rules: LimitRule[] = [{ dimension: "ip", limit: 1, windowMs: 60_000 }];
  const first = authorizeRequest(
    "registered_agent",
    ctx({ wallet: "0xa", agentId: "a1", signatureVerified: true }),
    rules,
  );
  const second = authorizeRequest(
    "registered_agent",
    ctx({ wallet: "0xb", agentId: "a2", signatureVerified: true }),
    rules,
  );
  assert.equal(first.allowed, true);
  assert.equal(second.allowed, true);
});

test("exceeding a limit returns a retryable error with a hint", () => {
  const rules: LimitRule[] = [{ dimension: "route", limit: 1, windowMs: 60_000 }];
  assert.equal(authorizeRequest("public_read", ctx(), rules).allowed, true);
  const blocked = authorizeRequest("public_read", ctx(), rules);
  assert.equal(blocked.error?.body.error.code, "rate_limited");
  assert.equal(blocked.error?.status, 429);
  assert.equal(blocked.error?.body.error.retryable, true);
  assert.ok(blocked.error?.headers["retry-after"]);
});

test("a refused request is not charged against the window", () => {
  // Charging one would let a caller already over the limit push the window forward
  // forever.
  const rules: LimitRule[] = [{ dimension: "route", limit: 1, windowMs: 1_000 }];
  const now = 1_000_000;
  authorizeRequest("public_read", ctx(), rules, now);
  authorizeRequest("public_read", ctx(), rules, now + 100);
  authorizeRequest("public_read", ctx(), rules, now + 200);
  // Window elapsed: allowed again rather than pushed out by the refusals.
  assert.equal(authorizeRequest("public_read", ctx(), rules, now + 1_100).allowed, true);
});

test("authorization is refused before a limit is consumed", () => {
  // A request that fails auth must not eat the caller's allowance.
  const rules: LimitRule[] = [{ dimension: "route", limit: 1, windowMs: 60_000 }];
  const denied = authorizeRequest("authenticated_user", ctx(), rules);
  assert.equal(denied.allowed, false);
  assert.equal(
    authorizeRequest("authenticated_user", ctx({ wallet: "0xabc" }), rules).allowed,
    true,
  );
});

// ── Tier declarations ─────────────────────────────────────────────────────────

test("every tier has a policy and is validated", () => {
  for (const tier of ACCESS_TIERS) {
    assert.equal(isAccessTier(tier), true);
    assert.equal(TIER_POLICIES[tier].tier, tier);
    assert.ok(TIER_POLICIES[tier].limitDimensions.length > 0, `${tier} has no limits`);
  }
  assert.equal(isAccessTier("admin_god_mode"), false);
});

test("every tier is rate-limited on at least the route", () => {
  for (const tier of ACCESS_TIERS) {
    assert.ok(TIER_POLICIES[tier].limitDimensions.includes("route"), tier);
  }
});

test("only the agent tier requires a signature", () => {
  const signing = ACCESS_TIERS.filter((t) => TIER_POLICIES[t].requiresSignature);
  assert.deepEqual(signing, ["registered_agent"]);
});
