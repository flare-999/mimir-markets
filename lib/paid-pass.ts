/**
 * Subscription passes for paid endpoints — one payment buys a time-boxed
 * window of free reads (the "recurring"/streaming-access tier).
 *
 * Stateless: a pass is an HMAC-signed `payer.exp.plan` token. No DB — verify by
 * recomputing the MAC. Note: bearer token (anyone holding it reuses it until
 * expiry); bind to caller identity + a nonce store if abuse becomes a concern.
 */

// Pure pass logic, importable by tests. Routes import `@/lib/server/paid-pass`,
// which carries the `server-only` marker so the signing secret never reaches a
// client bundle.
import { createHmac, timingSafeEqual } from "node:crypto";

function secret(): string {
  const s = process.env.PASS_SECRET;
  if (!s) throw new Error("PASS_SECRET required to sign passes");
  return s;
}

function sign(body: string): string {
  return createHmac("sha256", secret()).update(body).digest("base64url");
}

export interface PassClaims {
  payer: string;
  plan: string;
  exp: number; // ms epoch
}

/** Issue a pass valid for `ttlMs` from now. */
export function issuePass(payer: string, plan: string, ttlMs: number): { pass: string; expiresAt: number } {
  const exp = Date.now() + ttlMs;
  // Stellar strkeys are case-sensitive base32 — bind the pass to the payer
  // verbatim (trimmed). Lowercasing would yield a payer that is not a valid
  // address when echoed back to the client.
  const normalizedPayer = payer.trim();
  const body = `${normalizedPayer}.${exp}.${plan}`;
  const pass = `${Buffer.from(body).toString("base64url")}.${sign(body)}`;
  return { pass, expiresAt: exp };
}

/** Verify a pass for a given plan. Returns claims when valid + unexpired, else null. */
export function verifyPass(token: string | null | undefined, plan: string): PassClaims | null {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot < 0) return null;
  const body = Buffer.from(token.slice(0, dot), "base64url").toString("utf8");
  const mac = token.slice(dot + 1);
  const expected = sign(body);
  // Constant-time compare; bail if lengths differ (timingSafeEqual throws otherwise).
  if (mac.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;

  const [payer, expStr, p] = body.split(".");
  const exp = Number(expStr);
  if (!payer || !Number.isFinite(exp) || p !== plan) return null;
  if (Date.now() > exp) return null;
  return { payer, plan: p, exp };
}
