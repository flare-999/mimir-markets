import assert from "node:assert/strict";
import test from "node:test";
import nextConfig from "../../next.config.js";

/**
 * Security-header regression matrix for next.config.js — tightened for funded-state safety.
 *
 * Rollback: restore the previous headers() block in next.config.js and this
 * fixture if a header change breaks wallet framing (xBull/Albedo) or funded
 * connect flows. Prefer reverting the config, not relaxing CSP wildcards.
 *
 * Tightening notes (vs previous version):
 * - img-src no longer allows bare `https:` wildcard; only self, data:, dicebear, stellar.expert.
 * - connect-src now explicitly lists Stellar RPC/Horizon, PostHog, XMTP wss, plus https: for
 *   custom RPC compatibility, but wss: wildcard is removed (only explicit wss:// XMTP).
 * - worker-src, child-src, manifest-src, media-src, prefetch-src are now explicit operational
 *   boundaries (previously fell back to default-src/script-src).
 * - Additional hardening headers: Cross-Origin-Resource-Policy, X-DNS-Prefetch-Control,
 *   X-Permitted-Cross-Domain-Policies.
 */

const REQUIRED_KEYS = [
  "Content-Security-Policy",
  "Strict-Transport-Security",
  "X-Frame-Options",
  "X-Content-Type-Options",
  "Referrer-Policy",
  "Permissions-Policy",
  "Cross-Origin-Opener-Policy",
  "Cross-Origin-Resource-Policy",
  "X-DNS-Prefetch-Control",
  "X-Permitted-Cross-Domain-Policies",
] as const;

const EXPECTED_STATIC = {
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(self)",
  "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-DNS-Prefetch-Control": "off",
  "X-Permitted-Cross-Domain-Policies": "none",
} as const;

const CSP_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  // Tightened: explicit image origins, no bare https: wildcard
  "img-src 'self' data: https://api.dicebear.com https://stellar.expert",
  "font-src 'self' data:",
  // Tightened: explicit Stellar + PostHog + XMTP wss, plus https: for custom RPC compat
  "connect-src 'self' https://soroban-testnet.stellar.org https://horizon-testnet.stellar.org https://*.stellar.org https://api.dicebear.com https://*.posthog.com https://us.i.posthog.com https://us-assets.i.posthog.com wss://*.xmtp.network wss://*.xmtp.com https:",
  "frame-src 'self' https://wallet.xbull.app https://albedo.link",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
  // Operational boundaries: explicit
  "worker-src 'self' blob:",
  "child-src 'self' https://wallet.xbull.app https://albedo.link",
  "manifest-src 'self'",
  "media-src 'self'",
  "prefetch-src 'self'",
  "upgrade-insecure-requests",
] as const;

async function headerMatrix() {
  assert.ok(nextConfig.headers, "headers() must be configured");
  const rules = await nextConfig.headers!();
  assert.equal(rules.length, 1, "exactly one global header rule");
  assert.equal(rules[0].source, "/:path*", "global route coverage");
  const entries = rules[0].headers.map((entry: { key: string; value: string }) => [entry.key, entry.value] as const);
  assert.equal(new Set(entries.map(([key]) => key)).size, entries.length, "duplicate security header keys");
  return new Map(entries);
}

test("positive: all routes receive the complete browser security-header matrix", async () => {
  const headers = await headerMatrix();
  for (const key of REQUIRED_KEYS) assert.ok(headers.has(key), `missing ${key}`);
  for (const [key, value] of Object.entries(EXPECTED_STATIC)) {
    assert.equal(headers.get(key), value, key);
  }
});

test("positive: CSP is fail-closed with an explicit wallet frame allowlist", async () => {
  const headers = await headerMatrix();
  const csp = headers.get("Content-Security-Policy") ?? "";
  for (const directive of CSP_DIRECTIVES) {
    assert.match(csp, new RegExp(directive.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), directive);
  }
});

test("positive: CSP includes operational-boundary directives for workers and assets", async () => {
  const headers = await headerMatrix();
  const csp = headers.get("Content-Security-Policy") ?? "";
  assert.match(csp, /worker-src 'self' blob:/, "worker-src must be explicit self + blob:");
  assert.match(csp, /child-src 'self' https:\/\/wallet\.xbull\.app https:\/\/albedo\.link/, "child-src must mirror frame-src");
  assert.match(csp, /manifest-src 'self'/, "manifest-src self");
  assert.match(csp, /media-src 'self'/, "media-src self");
  assert.match(csp, /prefetch-src 'self'/, "prefetch-src self");
});

test("negative: wallet frame policy stays origin-scoped (no scheme wildcards)", async () => {
  const headers = await headerMatrix();
  const csp = headers.get("Content-Security-Policy") ?? "";
  // frame-src must not contain bare https: wildcard, only explicit origins
  const frameSrcMatch = csp.match(/frame-src[^;]+/);
  assert.ok(frameSrcMatch, "frame-src must exist");
  assert.doesNotMatch(frameSrcMatch[0], /\bhttps:\b/, "frame-src must not use bare https: wildcard");
  assert.doesNotMatch(csp, /frame-ancestors\s+\*/, "frame-ancestors must not allow any parent");
  assert.doesNotMatch(csp, /object-src\s+'?self'?/, "object-src must remain none");
});

test("negative: img-src is tightened to explicit origins, not bare https:", async () => {
  const headers = await headerMatrix();
  const csp = headers.get("Content-Security-Policy") ?? "";
  const imgSrcMatch = csp.match(/img-src[^;]+/);
  assert.ok(imgSrcMatch, "img-src must exist");
  // Should not have bare https: token
  const tokens = imgSrcMatch[0].split(/\s+/);
  assert.ok(!tokens.includes("https:"), "img-src must not contain bare https: wildcard");
  assert.match(imgSrcMatch[0], /https:\/\/api\.dicebear\.com/, "img-src must allow dicebear for avatars");
});

test("negative: connect-src restricts wss to explicit XMTP hosts", async () => {
  const headers = await headerMatrix();
  const csp = headers.get("Content-Security-Policy") ?? "";
  const connectMatch = csp.match(/connect-src[^;]+/);
  assert.ok(connectMatch, "connect-src must exist");
  // Should not have bare wss: wildcard
  const tokens = connectMatch[0].split(/\s+/);
  assert.ok(!tokens.includes("wss:"), "connect-src must not contain bare wss: wildcard, only explicit wss://");
  assert.match(connectMatch[0], /wss:\/\/\*\.xmtp\.network/, "must allow XMTP wss");
});

test("boundary: framing and HSTS values stay at funded-flow safe extrema", async () => {
  const headers = await headerMatrix();
  assert.equal(headers.get("X-Frame-Options"), "DENY");
  const hsts = headers.get("Strict-Transport-Security") ?? "";
  assert.match(hsts, /max-age=31536000/);
  assert.match(hsts, /includeSubDomains/);
  assert.doesNotMatch(hsts, /max-age=0/, "HSTS must not be disabled");
  const coop = headers.get("Cross-Origin-Opener-Policy") ?? "";
  assert.match(coop, /same-origin-allow-popups/, "Albedo popup signing requires allow-popups");
  const corp = headers.get("Cross-Origin-Resource-Policy") ?? "";
  assert.equal(corp, "same-origin", "CORP must be same-origin for funded-state safety");
});

test("failure: security headers must not embed credentials, secrets, or env-specific values", async () => {
  const headers = await headerMatrix();
  const secretShapes = [
    /(?:S[A-Z2-7]{55})/, // stellar secret key shape
    /(?:api[_-]?key|secret|token|password|private[_-]?key)\s*[=:]/i,
    /(?:sk_live|rk_live|ghp_|github_pat_)/i,
    /(?:localhost|127\.0\.0\.1|0\.0\.0\.0)/i,
  ];
  for (const [key, value] of headers.entries()) {
    for (const shape of secretShapes) {
      assert.doesNotMatch(value, shape, `${key} must not leak credential/env shape`);
    }
  }
});

test("regression: Permissions-Policy keeps payment self-scoped and sensors off", async () => {
  const headers = await headerMatrix();
  const pp = headers.get("Permissions-Policy") ?? "";
  assert.match(pp, /camera=\(\)/);
  assert.match(pp, /microphone=\(\)/);
  assert.match(pp, /geolocation=\(\)/);
  assert.match(pp, /payment=\(self\)/);
  assert.doesNotMatch(pp, /payment=\(\)/, "payment=(self) required for funded checkout surfaces");
});

test("regression: worker-src does not include unsafe-inline (tighter than script-src)", async () => {
  const headers = await headerMatrix();
  const csp = headers.get("Content-Security-Policy") ?? "";
  const workerMatch = csp.match(/worker-src[^;]+/);
  assert.ok(workerMatch);
  assert.doesNotMatch(workerMatch[0], /unsafe-inline/, "worker-src must not include unsafe-inline");
});
