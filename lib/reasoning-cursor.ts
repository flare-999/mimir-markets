/**
 * Cursor encoding/decoding for the public reasoning feed.
 *
 * The feed is ordered by (created_at DESC, event_id DESC). The cursor captures the
 * last row of a page so the next page can resume stably even when many events
 * share the same createdAt timestamp.
 */

export interface ReasoningCursor {
  createdAt: number;
  eventId: string;
}

const CURSOR_VERSION = 1;

/** Encode a cursor into an opaque, URL-safe string. */
export function encodeReasoningCursor(cursor: ReasoningCursor): string {
  const payload = JSON.stringify({
    v: CURSOR_VERSION,
    t: cursor.createdAt,
    e: cursor.eventId,
  });
  return Buffer.from(payload, "utf-8").toString("base64url");
}

/**
 * Decode a cursor string. Returns null for any malformed, missing, or
 * unsupported-version cursor so callers can fall back to the first page.
 */
export function decodeReasoningCursor(raw: string | null | undefined): ReasoningCursor | null {
  if (!raw) return null;
  try {
    const json = Buffer.from(raw, "base64url").toString("utf-8");
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.v !== CURSOR_VERSION) return null;
    if (typeof parsed.t !== "number" || !Number.isFinite(parsed.t)) return null;
    if (typeof parsed.e !== "string" || parsed.e.length === 0) return null;
    return { createdAt: parsed.t, eventId: parsed.e };
  } catch {
    return null;
  }
}
