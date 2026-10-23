import { type NextRequest } from "next/server";

/**
 * Extracts the client IP address from request headers for rate-limit bucketing.
 *
 * Precedence:
 * 1. Platform header (`x-vercel-forwarded-for` / `cf-connecting-ip`)
 * 2. `x-real-ip`
 * 3. First hop of `x-forwarded-for`
 *
 * Values are validated for length and charset; malformed values are ignored
 * and fall through to the next source. Returns `undefined` when no valid IP
 * is found so garbage never becomes a bucket key.
 */
export function clientIpFrom(headers: Headers): string | undefined {
  const candidates: Array<string | null | undefined> = [
    headers.get("x-vercel-forwarded-for"),
    headers.get("cf-connecting-ip"),
    headers.get("x-real-ip"),
    headers.get("x-forwarded-for")?.split(",")[0],
  ];

  for (const candidate of candidates) {
    const ip = normalizeIp(candidate);
    if (ip) return ip;
  }

  return undefined;
}

const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const IPV6_RE = /^[0-9a-fA-F:]+$/;

function normalizeIp(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 45) return undefined;

  if (IPV4_RE.test(trimmed)) {
    const octets = trimmed.split(".");
    if (octets.every((o) => Number(o) <= 255)) return trimmed;
    return undefined;
  }

  if (IPV6_RE.test(trimmed) && trimmed.includes(":")) {
    return trimmed;
  }

  return undefined;
}

/**
 * Validates the origin of a browser request to prevent Cross-Site Request Forgery (CSRF).
 * 
 * Mimir's API routes are consumed by both browsers and autonomous agents.
 * Browser requests must be protected from CSRF by ensuring the Origin or Referer
 * exactly matches the host they are targeting.
 * 
 * @returns true if the origin is safe, false if it is a suspected CSRF.
 */
export function verifyBrowserOrigin(req: NextRequest): boolean {
  // Public reads don't mutate state, so CSRF is less of a concern,
  // but if this is called, it assumes the route wants to mutate.
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
    return true;
  }

  const origin = req.headers.get("origin") ?? req.headers.get("referer");
  if (!origin) {
    // Browsers always send Origin on cross-origin POST requests.
    // If it's completely missing, it might be an agent or a very strict privacy extension.
    // But for browser-origin policy on mutating API routes, we require it unless it's a signed action.
    // We handle the "signed action" exemption at the policy layer.
    return false;
  }

  try {
    const originUrl = new URL(origin);
    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
    
    if (!host) return false;
    
    // Exact match on the hostname
    return originUrl.host === host;
  } catch {
    return false; // Malformed origin
  }
}
