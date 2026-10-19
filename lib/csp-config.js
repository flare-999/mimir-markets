/**
 * CommonJS CSP config for next.config.js — mirrors lib/csp.ts
 * This file is required by next.config.js which is CommonJS.
 * Keep in sync with lib/csp.ts.
 */

const CSP_DIRECTIVES = {
  "default-src": ["'self'"],
  "script-src": ["'self'", "'unsafe-inline'"],
  "style-src": ["'self'", "'unsafe-inline'"],
  "img-src": ["'self'", "data:", "https://api.dicebear.com", "https://stellar.expert"],
  "font-src": ["'self'", "data:"],
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
  "frame-src": ["'self'", "https://wallet.xbull.app", "https://albedo.link"],
  "frame-ancestors": ["'none'"],
  "base-uri": ["'self'"],
  "form-action": ["'self'"],
  "object-src": ["'none'"],
  "worker-src": ["'self'", "blob:"],
  "child-src": ["'self'", "https://wallet.xbull.app", "https://albedo.link"],
  "manifest-src": ["'self'"],
  "media-src": ["'self'"],
  "prefetch-src": ["'self'"],
};

const CSP_UPGRADE_INSECURE = "upgrade-insecure-requests";

function buildCSP() {
  const parts = Object.entries(CSP_DIRECTIVES).map(
    ([directive, values]) => `${directive} ${values.join(" ")}`
  );
  parts.push(CSP_UPGRADE_INSECURE);
  return parts.join("; ");
}

const SECURITY_HEADERS = {
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
};

module.exports = {
  CSP_DIRECTIVES,
  CSP_UPGRADE_INSECURE,
  buildCSP,
  SECURITY_HEADERS,
};
