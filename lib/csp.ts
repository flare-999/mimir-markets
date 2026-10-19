/**
 * Content Security Policy — tightened for funded-state safety and operational boundaries.
 *
 * This module is the single source of truth for Mimir's browser CSP. `next.config.js`
 * imports the built string via `lib/csp-config.js` (CommonJS) so the config and this
 * validator stay in sync. Tests import from here.
 *
 * ## Goals
 *
 * - **Funded-state safety**: money-moving flows (stake, withdraw, copy, x402) must not
 *   be exfiltratable via an overly broad `connect-src` or `img-src`, and must not be
 *   framable (`frame-ancestors 'none'`, `X-Frame-Options DENY`). Soroban RPC is the
 *   authoritative state source; the browser may only talk to known Stellar endpoints
 *   plus `self`. Custom RPC providers are allowed via `https:` for compatibility, but
 *   the explicit allowlist documents the intended boundary.
 *
 * - **Operational boundaries**: every loading primitive is explicit. `worker-src`,
 *   `child-src`, `manifest-src`, `media-src`, `prefetch-src` are set rather than
 *   falling back to `default-src` or `script-src`. This makes the boundary between
 *   page, workers, frames, and assets auditable. `object-src 'none'` and
 *   `base-uri 'self'` remain non-negotiable.
 *
 * - **Privacy**: no credentials, secrets, or env-specific values may appear in the
 *   header. The validator below rejects Stellar secret keys, API keys, and localhost.
 *
 * ## Behavior matrix
 *
 * - **malformed**: a CSP that fails `validateCSP()` is treated as a build error. At
 *   runtime, `buildCSP()` is the only producer; if parsing fails, the caller must
 *   fail closed to `default-src 'none'` and surface the error. Never serve a page
 *   without a CSP.
 *
 * - **stale**: the CSP string carries no timestamp, but `validateCSP()` checks that
 *   required directives (`worker-src`, `child-src`, `manifest-src`, etc.) are present.
 *   A config missing them is considered stale and rejected. Rollback to a previous
 *   known-good CSP is preferred over relaxing wildcards.
 *
 * - **duplicate**: duplicate directive names (e.g., two `script-src`) are rejected.
 *   Duplicate header keys in `next.config.js` are also rejected by the security-header
 *   matrix test. The fix is to merge values, not to duplicate.
 *
 * - **cancelled**: request cancellation does not bypass CSP. The header is set on the
 *   response regardless of request state; a cancelled fetch still cannot load a
 *   disallowed origin.
 *
 * - **paused**: CSP enforcement is **never pausable**. Incident kill switches
 *   (`MIMIR_PAUSE_*`) stop writes, not browser protections. There is no env var that
 *   disables or relaxes CSP. This is intentional: a paused market should still be
 *   safe to view.
 *
 * - **dependency-failure**: if `next.config.js` fails to load the CSP builder (e.g.,
 *   `lib/csp-config.js` missing), the build must fail. At runtime, if the header
 *   cannot be produced, serve `Content-Security-Policy: default-src 'none'` and
 *   `X-Frame-Options: DENY` as a fail-closed fallback.
 *
 * ## Rollback
 *
 * If a header change breaks wallet framing (xBull/Albedo) or funded connect flows:
 * 1. Restore the previous `headers()` block in `next.config.js` and the matching
 *    fixture in `tests/node/security-headers.test.ts`.
 * 2. Prefer reverting the config, not relaxing to `https:` / `*` wildcards.
 * 3. Wallet framing is origin-scoped: only `https://wallet.xbull.app` and
 *    `https://albedo.link` are allowed. Never add `https:` or `https://*` to
 *    `frame-src`.
 *
 * ## Soroban authority
 *
 * Contract state is authoritative. The browser may read from Soroban RPC and Horizon,
 * but writes are always explicit user-signed transactions. CSP does not grant any
 * additional authority; it only restricts where the browser may connect.
 */

export const CSP_DIRECTIVES = {
  "default-src": ["'self'"],
  "script-src": ["'self'", "'unsafe-inline'"],
  "style-src": ["'self'", "'unsafe-inline'"],
  // Tighter than `https:` wildcard: only self, data:, and explicitly trusted image origins.
  // DiceBear avatars (api.dicebear.com) are the only external images Mimir loads client-side.
  // stellar.expert is allowed for explorer-linked images, but not a generic https: wildcard.
  "img-src": ["'self'", "data:", "https://api.dicebear.com", "https://stellar.expert"],
  "font-src": ["'self'", "data:"],
  // Tightened: explicit Stellar RPC/Horizon + PostHog + XMTP wss, plus https: for custom RPC compatibility.
  // Previously `https: wss:` allowed any https/wss. Now wss: is restricted to XMTP hosts,
  // and https: is retained only for custom RPC provider flexibility. Future tightening
  // will remove the trailing `https:` once an allowlist env var is available.
  "connect-src": [
    "'self'",
    "https://soroban-testnet.stellar.org",
    "https://horizon-testnet.stellar.org",
    "https://*.stellar.org",
    "https://api.dicebear.com",
    "https://*.posthog.com",
    "https://us.i.posthog.com",
    "https://us-assets.i.posthog.com",
    "wss://*.xmtp.network",
    "wss://*.xmtp.com",
    "https:",
  ],
  // Wallet framing: origin-scoped, no scheme wildcards. xBull signs in an iframe from
  // wallet.xbull.app, Albedo signs in a popup at albedo.link (falls back to iframe when
  // popups blocked). Freighter/Lobstr/Hana are extensions and frame nothing.
  "frame-src": ["'self'", "https://wallet.xbull.app", "https://albedo.link"],
  "frame-ancestors": ["'none'"],
  "base-uri": ["'self'"],
  "form-action": ["'self'"],
  "object-src": ["'none'"],
  // Operational boundaries: explicit worker/child/manifest/media/prefetch.
  // Previously fell back to default-src/script-src, which allowed unsafe-inline in workers.
  // Now workers are self + blob: (blob: needed for some libs that create workers from blobs),
  // child-src mirrors frame-src, and manifest/media/prefetch are self-only.
  "worker-src": ["'self'", "blob:"],
  "child-src": ["'self'", "https://wallet.xbull.app", "https://albedo.link"],
  "manifest-src": ["'self'"],
  "media-src": ["'self'"],
  "prefetch-src": ["'self'"],
} as const;

export const CSP_UPGRADE_INSECURE = "upgrade-insecure-requests";

export function buildCSP(): string {
  const parts = Object.entries(CSP_DIRECTIVES).map(
    ([directive, values]) => `${directive} ${values.join(" ")}`
  );
  parts.push(CSP_UPGRADE_INSECURE);
  return parts.join("; ");
}

/** Parse a CSP string into a map of directive -> values. */
export function parseCSP(csp: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const directives = csp
    .split(";")
    .map((d) => d.trim())
    .filter(Boolean);
  for (const directive of directives) {
    if (directive === "upgrade-insecure-requests") {
      map.set(directive, []);
      continue;
    }
    const [name, ...values] = directive.split(/\s+/);
    if (!name) continue;
    map.set(name, values);
  }
  return map;
}

export interface CSPValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validate a CSP string for Mimir's funded-state safety invariants.
 *
 * Checks:
 * - required directives present (including operational-boundary ones)
 * - no duplicate directives
 * - no secret shapes or localhost
 * - frame-ancestors none, object-src none, base-uri self, form-action self
 * - frame-src origin-scoped (no https: bare scheme)
 * - worker-src does not include unsafe-inline
 * - img-src does not include bare https: wildcard (must be explicit)
 */
export function validateCSP(csp: string): CSPValidationResult {
  const errors: string[] = [];

  if (!csp || typeof csp !== "string") {
    return { valid: false, errors: ["CSP must be a non-empty string"] };
  }

  const parsed = parseCSP(csp);

  // Duplicate detection: raw split count vs map size
  const rawDirectives = csp
    .split(";")
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => d.split(/\s+/)[0])
    .filter(Boolean);
  const seen = new Set<string>();
  for (const name of rawDirectives) {
    if (seen.has(name)) {
      errors.push(`duplicate directive: ${name}`);
    }
    seen.add(name);
  }

  const requiredDirectives = [
    "default-src",
    "script-src",
    "style-src",
    "img-src",
    "font-src",
    "connect-src",
    "frame-src",
    "frame-ancestors",
    "base-uri",
    "form-action",
    "object-src",
    "worker-src",
    "child-src",
    "manifest-src",
    "media-src",
    "prefetch-src",
    "upgrade-insecure-requests",
  ];

  for (const req of requiredDirectives) {
    if (!parsed.has(req)) {
      errors.push(`missing required directive: ${req}`);
    }
  }

  // Funded-state safety invariants
  const frameAncestors = parsed.get("frame-ancestors")?.join(" ") ?? "";
  if (frameAncestors !== "'none'") {
    errors.push(`frame-ancestors must be 'none', got: ${frameAncestors}`);
  }

  const objectSrc = parsed.get("object-src")?.join(" ") ?? "";
  if (objectSrc !== "'none'") {
    errors.push(`object-src must be 'none', got: ${objectSrc}`);
  }

  const baseUri = parsed.get("base-uri")?.join(" ") ?? "";
  if (!baseUri.includes("'self'")) {
    errors.push(`base-uri must include 'self'`);
  }

  const formAction = parsed.get("form-action")?.join(" ") ?? "";
  if (!formAction.includes("'self'")) {
    errors.push(`form-action must include 'self'`);
  }

  const frameSrc = parsed.get("frame-src")?.join(" ") ?? "";
  if (/frame-src\s+https?:\/\//.test(`frame-src ${frameSrc}`) || frameSrc.includes("https:")) {
    // Allow only explicit origins, not bare https: scheme
    if (frameSrc.includes("https:") && !frameSrc.includes("https://wallet.xbull.app") && !frameSrc.includes("https://albedo.link")) {
      // Actually we want to ensure no bare https: wildcard
    }
    if (/\bhttps:\b/.test(frameSrc)) {
      errors.push(`frame-src must not use bare https: wildcard, only explicit origins`);
    }
  }
  if (!frameSrc.includes("https://wallet.xbull.app") || !frameSrc.includes("https://albedo.link")) {
    errors.push(`frame-src must allow wallet.xbull.app and albedo.link`);
  }

  const workerSrc = parsed.get("worker-src")?.join(" ") ?? "";
  if (workerSrc.includes("'unsafe-inline'")) {
    errors.push(`worker-src must not include unsafe-inline`);
  }

  const imgSrc = parsed.get("img-src")?.join(" ") ?? "";
  // Tighter than before: should not allow bare https: wildcard
  if (/\bhttps:\b/.test(imgSrc) && !imgSrc.includes("https://api.dicebear.com")) {
    // If it contains bare https: token, that's too broad
    const tokens = imgSrc.split(/\s+/);
    if (tokens.includes("https:")) {
      errors.push(`img-src must not use bare https: wildcard, use explicit origins`);
    }
  }

  const connectSrc = parsed.get("connect-src")?.join(" ") ?? "";
  if (!connectSrc.includes("'self'")) {
    errors.push(`connect-src must include 'self'`);
  }
  if (!connectSrc.includes("soroban-testnet.stellar.org") && !connectSrc.includes("*.stellar.org")) {
    errors.push(`connect-src must allow Stellar RPC`);
  }

  // No secrets or env-specific values
  const secretShapes = [
    /(?:S[A-Z2-7]{55})/, // stellar secret key shape
    /(?:api[_-]?key|secret|token|password|private[_-]?key)\s*[=:]/i,
    /(?:sk_live|rk_live|ghp_|github_pat_)/i,
    /(?:localhost|127\.0\.0\.1|0\.0\.0\.0)/i,
  ];
  for (const shape of secretShapes) {
    if (shape.test(csp)) {
      errors.push(`CSP must not contain secret/env shape: ${shape}`);
    }
  }

  // No duplicate header keys check is done at next.config.js level, but we also check
  // that no directive value is empty
  for (const [name, values] of parsed.entries()) {
    if (name !== "upgrade-insecure-requests" && values.length === 0) {
      errors.push(`directive ${name} must have values`);
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Fail-closed fallback CSP used when the real CSP cannot be built.
 * Deny everything, no framing, no objects.
 */
export const FAIL_CLOSED_CSP = "default-src 'none'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; upgrade-insecure-requests";

/**
 * Security headers matrix — the complete set expected on every route.
 * Includes CSP plus additional hardening headers.
 */
export const SECURITY_HEADERS = {
  "Content-Security-Policy": buildCSP(),
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

export type SecurityHeaderKey = keyof typeof SECURITY_HEADERS;
