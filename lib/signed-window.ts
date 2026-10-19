/**
 * Freshness window for owner-signed authorisations (copy-trading grants and
 * revocations, basket subscriptions).
 *
 * A signature over a message without a nonce or an expiry is a bearer token
 * that never dies: anyone who ever saw the request body can replay it. Every
 * owner-signed message therefore carries a client-generated nonce, consumed
 * server-side on first use, and an `expiresAt` the server bounds to a short
 * window. The window must stay at or below the durable nonce store's TTL
 * (`NONCE_TTL_MS`, ten minutes) so a nonce cannot be forgotten while the
 * message that carries it is still acceptable.
 *
 * Pure and client-safe: the browser builds the same message it signs.
 */

/** Longest an owner-signed authorisation may remain acceptable. */
export const SIGNED_ACTION_MAX_TTL_MS = 5 * 60_000;

const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

export type SignedWindowResult =
  | { ok: true; nonce: string; expiresAt: number }
  | { ok: false; code: "invalid_request" | "request_expired"; message: string; field: "nonce" | "expiresAt" };

/** Validate the nonce shape and that `expiresAt` is in (now, now + max TTL]. */
export function validateSignedWindow(
  rawNonce: unknown,
  rawExpiresAt: unknown,
  now = Date.now(),
): SignedWindowResult {
  const nonce = typeof rawNonce === "string" ? rawNonce.trim() : "";
  if (!NONCE_PATTERN.test(nonce)) {
    return { ok: false, code: "invalid_request", message: "nonce must be 16-128 characters of [A-Za-z0-9_-]", field: "nonce" };
  }
  const expiresAt = typeof rawExpiresAt === "number" ? rawExpiresAt : Number.NaN;
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) {
    return { ok: false, code: "request_expired", message: "expiresAt is missing or already past", field: "expiresAt" };
  }
  if (expiresAt > now + SIGNED_ACTION_MAX_TTL_MS) {
    return {
      ok: false,
      code: "invalid_request",
      message: `expiresAt may not be more than ${SIGNED_ACTION_MAX_TTL_MS / 1000}s in the future`,
      field: "expiresAt",
    };
  }
  return { ok: true, nonce, expiresAt };
}
