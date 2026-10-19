const createNextIntlPlugin = require("next-intl/plugin");
const withNextIntl = createNextIntlPlugin("./i18n/request.ts");
const { SECURITY_HEADERS } = require("./lib/csp-config.js");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        // Tightened CSP for funded-state safety and clear operational boundaries.
        //
        // Funded-state safety: frame-ancestors 'none', object-src 'none', base-uri 'self',
        // form-action 'self' remain non-negotiable. Soroban RPC is authoritative — connect-src
        // allows self + explicit Stellar endpoints + PostHog + XMTP wss, plus https: for custom
        // RPC provider compatibility. img-src is explicit (self, data:, dicebear, stellar.expert)
        // rather than a bare https: wildcard, preventing exfiltration via arbitrary images.
        //
        // Operational boundaries: worker-src, child-src, manifest-src, media-src, prefetch-src
        // are explicit rather than falling back to default-src/script-src. worker-src is self
        // + blob: (blob: needed for libs that create workers from blobs) without unsafe-inline,
        // which is tighter than inheriting script-src's unsafe-inline. child-src mirrors frame-src.
        //
        // Wallet framing: origin-scoped only. xBull signs in an iframe from wallet.xbull.app,
        // Albedo signs in a popup at albedo.link (falls back to iframe when popups blocked).
        // Freighter/Lobstr/Hana are extensions and frame nothing. Never add https: or * to frame-src.
        //
        // Additional hardening headers: Cross-Origin-Resource-Policy same-origin,
        // X-DNS-Prefetch-Control off, X-Permitted-Cross-Domain-Policies none.
        //
        // Rollback: restore previous headers() block in this file and the matching fixture in
        // tests/node/security-headers.test.ts if a change breaks wallet framing or funded flows.
        // Prefer reverting config, not relaxing CSP wildcards.
        //
        // Behavior matrix:
        // - malformed: validateCSP() in lib/csp.ts rejects malformed CSP; build fails closed to default-src 'none'.
        // - stale: missing operational-boundary directives (worker-src etc.) is treated as stale and rejected.
        // - duplicate: duplicate directive names or header keys are rejected.
        // - cancelled: cancellation does not bypass CSP; header still enforced.
        // - paused: CSP is never pausable (no MIMIR_PAUSE_* for headers).
        // - dependency-failure: if csp-config.js fails to load, build fails; runtime fallback is default-src 'none'.
        { key: "Content-Security-Policy", value: SECURITY_HEADERS["Content-Security-Policy"] },
        { key: "Strict-Transport-Security", value: SECURITY_HEADERS["Strict-Transport-Security"] },
        { key: "X-Frame-Options", value: SECURITY_HEADERS["X-Frame-Options"] },
        { key: "X-Content-Type-Options", value: SECURITY_HEADERS["X-Content-Type-Options"] },
        { key: "Referrer-Policy", value: SECURITY_HEADERS["Referrer-Policy"] },
        { key: "Permissions-Policy", value: SECURITY_HEADERS["Permissions-Policy"] },
        { key: "Cross-Origin-Opener-Policy", value: SECURITY_HEADERS["Cross-Origin-Opener-Policy"] },
        { key: "Cross-Origin-Resource-Policy", value: SECURITY_HEADERS["Cross-Origin-Resource-Policy"] },
        { key: "X-DNS-Prefetch-Control", value: SECURITY_HEADERS["X-DNS-Prefetch-Control"] },
        { key: "X-Permitted-Cross-Domain-Policies", value: SECURITY_HEADERS["X-Permitted-Cross-Domain-Policies"] },
      ],
    }];
  },
  // Pin Turbopack's workspace root. A stray ~/package-lock.json makes Next infer
  // the wrong root (C:\\Users\\enliven) and serve an empty app dir → every route
  // 404s. Anchoring to this file's dir fixes dev and prod builds alike.
  turbopack: {
    root: __dirname,
    // No resolveAlias entries. Both stubs that used to live here existed to
    // satisfy a dynamic import inside the embedded-wallet SDK's dependency tree —
    // an unreachable Solana branch and a card-funding onramp — and that SDK is
    // gone. Mimir's own x402 scheme (lib/x402/stellar-scheme.ts) imports only
    // @x402/core and @stellar/stellar-sdk, neither of which lazily resolves a
    // chain module Turbopack cannot find.
  },
};

module.exports = withNextIntl(nextConfig);
