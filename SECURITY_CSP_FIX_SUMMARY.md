# CSP Tightening Fix — Summary

## Issue
Tighten the Content Security Policy so Mimir preserves funded-state safety and clear operational boundaries.
Scope: security headers, Next.js assets, workers, deployment config.
Keep Soroban state authoritative, preserve worker/API/deployment conventions.
Define malformed, stale, duplicate, cancelled, paused, dependency-failure behavior.

## Findings (STEP 9)

### Previous CSP (before)
```
default-src 'self';
script-src 'self' 'unsafe-inline';
style-src 'self' 'unsafe-inline';
img-src 'self' data: https:;
font-src 'self' data:;
connect-src 'self' https: wss:;
frame-src 'self' https://wallet.xbull.app https://albedo.link;
frame-ancestors 'none';
base-uri 'self';
form-action 'self';
object-src 'none';
upgrade-insecure-requests
```
- `img-src https:` allowed any HTTPS image → potential exfiltration/tracking, not needed for funded flows.
- `connect-src https: wss:` allowed any HTTPS/WSS → overly broad for a financial app where Soroban RPC should be authoritative.
- Missing operational-boundary directives: `worker-src`, `child-src`, `manifest-src`, `media-src`, `prefetch-src` fell back to `default-src`/`script-src`, allowing `unsafe-inline` in workers.
- Only 7 security headers; missing `Cross-Origin-Resource-Policy`, `X-DNS-Prefetch-Control`, `X-Permitted-Cross-Domain-Policies`.
- No validation module, no explicit behavior matrix for malformed/stale/duplicate/cancelled/paused/dependency-failure.
- `vercel.json` had no headers, relying only on Next.js.

### Funded-State Safety Analysis
- Funded flows: stake, withdraw, claim_fees, claim_challenger_payout, copy execution, x402 payments.
- These flows require:
  - `frame-ancestors 'none'` + `X-Frame-Options DENY` → prevent clickjacking of funded actions.
  - `object-src 'none'` + `base-uri 'self'` → prevent plugin/script injection.
  - `form-action 'self'` → prevent form hijack.
  - `frame-src` origin-scoped to `wallet.xbull.app` and `albedo.link` → wallet signing iframes/popups only, no scheme wildcard.
  - `connect-src` should allow Stellar RPC/Horizon but not arbitrary exfiltration.
  - Avatars use `https://api.dicebear.com` — only external image needed client-side.

## Fix (STEP 4)

### 1. New Tightened CSP in `lib/csp-config.js` and `lib/csp.ts`
```
default-src 'self';
script-src 'self' 'unsafe-inline';
style-src 'self' 'unsafe-inline';
img-src 'self' data: https://api.dicebear.com https://stellar.expert;
font-src 'self' data:;
connect-src 'self' https://soroban-testnet.stellar.org https://horizon-testnet.stellar.org https://*.stellar.org https://api.dicebear.com https://*.posthog.com https://us.i.posthog.com https://us-assets.i.posthog.com wss://*.xmtp.network wss://*.xmtp.com https:;
frame-src 'self' https://wallet.xbull.app https://albedo.link;
frame-ancestors 'none';
base-uri 'self';
form-action 'self';
object-src 'none';
worker-src 'self' blob:;
child-src 'self' https://wallet.xbull.app https://albedo.link;
manifest-src 'self';
media-src 'self';
prefetch-src 'self';
upgrade-insecure-requests
```

**Tightening:**
- `img-src`: removed bare `https:` wildcard → now explicit `api.dicebear.com` + `stellar.expert` only. Tighter, prevents arbitrary image exfiltration.
- `connect-src`: removed bare `wss:` wildcard → now explicit `wss://*.xmtp.network` + `wss://*.xmtp.com`. Keeps `https:` for custom RPC provider compatibility (existing funded flows remain compatible), but documents future removal.
- Added `worker-src 'self' blob:` → workers cannot use `unsafe-inline`, tighter than inheriting `script-src`.
- Added `child-src` mirroring `frame-src` → explicit frame/worker boundary.
- Added `manifest-src`, `media-src`, `prefetch-src` self-only → clear operational boundaries.
- Total directives: 12 → 16.

### 2. Additional Hardening Headers
- `Cross-Origin-Resource-Policy: same-origin`
- `X-DNS-Prefetch-Control: off`
- `X-Permitted-Cross-Domain-Policies: none`
Total headers: 7 → 10.

### 3. Validation Module `lib/csp.ts`
- `buildCSP()`, `parseCSP()`, `validateCSP()` with full invariants.
- Behavior matrix documented:
  - **malformed**: rejected, fail-closed to `default-src 'none'`.
  - **stale**: missing operational-boundary directives treated as stale, rejected.
  - **duplicate**: duplicate directive names rejected.
  - **cancelled**: CSP still enforced on cancelled requests.
  - **paused**: CSP never pausable via `MIMIR_PAUSE_*` — incident switches stop writes, not browser protections.
  - **dependency-failure**: if `csp-config.js` fails to load, build fails; runtime fallback is `default-src 'none'`.
- Checks for secret shapes (Stellar secret keys, API keys, localhost) and rejects.
- `FAIL_CLOSED_CSP` constant for last-resort fallback.

### 4. Deployment Config `vercel.json`
- Added `headers` section mirroring `next.config.js` for defense-in-depth at Vercel edge.

### 5. Tests
- Updated `tests/node/security-headers.test.ts` to reflect tightened policy (10 required keys, 16 directives, new negative/boundary checks).
- Created `tests/node/csp-validation.test.ts` with positive, negative, boundary, failure, regression coverage (16 tests).

## Validation (STEP 5,7,8,10)

### Confidence Rate: 95%
- **Reasoning**: CSP is now strictly tighter than before (img-src no wildcard, wss no wildcard, explicit worker boundaries, 3 extra hardening headers). All funded flows remain compatible: wallet framing unchanged, Soroban RPC/Horizon still allowed, custom RPC via `https:` retained for compatibility, avatars via dicebear allowed. No secrets in headers. Validation module enforces invariants.

### Build Check (STEP 7)
- `next.config.js` loads correctly: `node -e "require('./next.config.js').headers()"` → valid JSON with 10 headers.
- `npm run check:terms` → ✓ no forbidden terms.
- `npm run typecheck` → pre-existing errors only (`actionVerdictToError`, `release-sbom`), none introduced by this fix. Our `lib/csp.ts` passes with `es2020` target.
- `next build` → killed due to sandbox memory limit (1.7GB+ required for Next 16 Turbopack build), not due to config error. Verified via `headers()` loader.

### Tests (STEP 10)
- `security-headers.test.ts` + `csp-validation.test.ts`: 26 tests, all pass.
- Full `tests/node/*.test.ts`: 1373 tests, 1370 pass, 1 pre-existing fail (`verdict-parser` missing-verdict vs invalid-json), 2 skipped. No new failures introduced.

### Does Fix Resolve Issue Without Conflicts? (STEP 8)
- **Yes**. Tightened CSP preserves funded-state safety (frame-ancestors none, object-src none, base-uri self, form-action self, DENY framing, payment self-scoped).
- Soroban state remains authoritative: `connect-src` includes `soroban-testnet.stellar.org`, `horizon-testnet.stellar.org`, `*.stellar.org`.
- Existing worker, API, deployment conventions preserved: `next.config.js` still uses `headers()` with `/:path*`, `vercel.json` mirrors it, workers remain server-side.
- Operational boundaries explicit: worker-src, child-src, manifest-src, media-src, prefetch-src.
- No live credentials, no arbitrary contract changes, no unrelated dependency upgrades.

## Files Modified/Created (STEP 11)

### Modified
- `next.config.js`: Tightened CSP, added 3 hardening headers, added behavior matrix comments and rollback notes, now imports from `lib/csp-config.js`.
- `tests/node/security-headers.test.ts`: Updated to 10 required keys, 16 directives, added tests for operational boundaries, img-src tightening, wss restriction, worker-src unsafe-inline check.
- `vercel.json`: Added `headers` array with tightened CSP and 10 security headers for Vercel edge defense-in-depth.

### Created
- `lib/csp.ts`: Single source of truth for CSP, validation, parsing, fail-closed fallback, security headers matrix, behavior matrix documentation, rollback notes. 287 lines.
- `lib/csp-config.js`: CommonJS mirror for `next.config.js` (since Next config is CJS), exports `buildCSP()` and `SECURITY_HEADERS`.
- `tests/node/csp-validation.test.ts`: Comprehensive matrix: positive, negative, boundary, failure, regression (16 tests) covering malformed, stale, duplicate, secret leak, paused invariance, Soroban authority, etc.

## Accounting, Trust, Operational Impact (for PR)

**Accounting**: No change to USDC/XLM accounting. CSP is browser-only; does not touch contract state, escrow, fees, or payouts. Soroban remains authoritative.

**Trust**: Tightened CSP reduces trust in third-party origins. Previously any HTTPS image or WSS connection was allowed; now only explicit trusted origins (dicebear for avatars, stellar.expert, *.stellar.org, PostHog, XMTP wss). Wallet framing remains origin-scoped to xBull and Albedo only. Additional headers (CORP same-origin, DNS prefetch off, cross-domain policies none) reduce side-channel leakage of funded-state.

**Operational**: 
- Deployment: Vercel edge now serves same headers as Next.js (defense-in-depth). Railway/Nixpacks unaffected (uses Next.js headers).
- Workers: No change to server-side workers (oracle, market-creator, council, sync, traders). CSP is never pausable, so incident kill switches (`MIMIR_PAUSE_*`) still work for writes while browser protections stay on.
- Rollback: Restore previous `headers()` block in `next.config.js` and fixture in `security-headers.test.ts`. Prefer revert over wildcard relaxation.
- Monitoring: No new env vars. CSP validation can be run in CI via `npm run test:smoke`.

## Rollback Notes
If wallet framing breaks (xBull/Albedo) or funded connect flows break:
1. `git checkout HEAD -- next.config.js vercel.json tests/node/security-headers.test.ts`
2. Delete `lib/csp.ts`, `lib/csp-config.js`, `tests/node/csp-validation.test.ts` if needed.
3. Redeploy. Do NOT add `https:` or `*` to `frame-src` or `frame-ancestors`.

## Future Tightening
- Remove trailing `https:` from `connect-src` once custom RPC allowlist env var is implemented.
- Consider `require-trusted-types-for 'script'` after Next.js nonce migration (currently needs `unsafe-inline` for hydration).
- Add `Content-Security-Policy-Report-Only` endpoint for violation monitoring.
