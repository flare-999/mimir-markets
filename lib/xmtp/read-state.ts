"use client";

/**
 * Per-thread read-state for the VS messages hub.
 *
 * The hub lists threads and needs to know which ones have messages the user hasn't
 * seen yet. We persist the last-read timestamp per thread id in localStorage
 * (namespaced + size-capped) and derive the unread flag from the latest message
 * timestamp the hub already has.
 *
 * Everything here is pure and side-effect free except for the localStorage
 * accessors, which degrade silently on any failure (quota, private mode, disabled
 * storage, malformed JSON). That keeps the hub resilient without a read-state
 * dependency being a crash source.
 */

export const READ_STATE_STORAGE_KEY = "vs:xmtp:read-state:v1";

/** Max number of thread entries we persist. */
export const READ_STATE_MAX_ENTRIES = 200;

/** Maximum number of characters in the serialized payload. */
export const READ_STATE_MAX_PAYLOAD_CHARS = 64_000;

/** Map of thread id -> last-read timestamp (ms). */
export type ReadStateMap = Record<string, number>;

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function getStorage(): StorageLike | null {
  try {
    if (typeof window === "undefined") return null;
    const storage = window.localStorage;
    if (!storage) return null;
    return storage;
  } catch {
    // SecurityError (cookies disabled) or similar.
    return null;
  }
}

/**
 * Parse a serialized read-state payload into a sane map. Any malformed
 * entry is dropped instead of throwing, so a corrupted store never breaks the
 * hub.
 */
export function parseReadState(raw: string | null | undefined): ReadStateMap {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }
  const out: ReadStateMap = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof key !== "string" || key.length === 0) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      continue;
    }
    out[key] = value;
  }
  return out;
}

/**
 * Serialize the read-state map, dropping the oldest entries when the map
 * exceeds the entry cap or the payload exceeds the character cap. Returns
 * `null` when the map is empty so callers can skip the write entirely.
 */
export function serializeReadState(map: ReadStateMap): string | null {
  const entries = Object.entries(map).filter(
    ([, value]) => typeof value === "number" && Number.isFinite(value) && value >= 0
  );
  if (entries.length === 0) return null;

  // Newest read timestamps first so the cap keeps the most relevant threads.
  entries.sort((a, b) => b[1] - a[1]);
  const trimmed = entries.slice(0, READ_STATE_MAX_ENTRIES);

  let payload = JSON.stringify(Object.fromEntries(trimmed));
  while (payload.length > READ_STATE_MAX_PAYLOAD_CHARS && trimmed.length > 1) {
    trimmed.pop();
    payload = JSON.stringify(Object.fromEntries(trimmed));
  }
  return payload;
}

/**
 * Load the persisted read-state. Returns an empty map on any failure
 * (storage unavailable, corrupt JSON, etc.).
 */
export function loadReadState(): ReadStateMap {
  const storage = getStorage();
  if (!storage) return {};
  try {
    return parseReadState(storage.getItem(READ_STATE_STORAGE_KEY));
  } catch {
    return {};
  }
}

/**
 * Persist the read-state map. Storage failures (quota, private mode, disabled
 * storage) are swallowed silently: the in-memory state remains the source of
 * truth for the current session.
 */
export function saveReadState(map: ReadStateMap): void {
  const storage = getStorage();
  if (!storage) return;
  const payload = serializeReadState(map);
  try {
    if (payload === null) {
      // Use setItem with an empty payload fallback if removeItem isn't available.
      if (typeof storage.removeItem === "function") {
        storage.removeItem(READ_STATE_STORAGE_KEY);
      } else {
        storage.setItem(READ_STATE_STORAGE_KEY, "");
      }
      return;
    }
    storage.setItem(READ_STATE_STORAGE_KEY, payload);
  } catch {
    // QuotaExceeded / SecurityError / etc. — degrade silently.
  }
}

/**
 * Record that a thread was opened / read at the given timestamp.
 * Returns the updated map so callers can keep an in-memory copy in sync.
 */
export function markThreadRead(
  map: ReadStateMap,
  threadId: string,
  readAt: number = Date.now()
): ReadStateMap {
  if (!threadId) return map;
  const safe = Number.isFinite(readAt) && readAt >= 0 ? readAt : Date.now();
  const prev = map[threadId] ?? 0;
  // Never move the marker backwards.
  const next = Math.max(prev, safe);
  if (next === prev && threadId in map) return map;
  return { ...map, [threadId]: next };
}

/**
 * Compute whether a thread has unread messages given its latest message
 * timestamp and the persisted last-read marker. A thread with no messages
 * (or an unknown timestamp) is never unread.
 */
export function isThreadUnread(
  map: ReadStateMap,
  threadId: string,
  latestMessageAt: number | null | undefined
): boolean {
  if (!threadId) return false;
  if (typeof latestMessageAt !== "number" || !Number.isFinite(latestMessageAt)) {
    return false;
  }
  const lastRead = map[threadId];
  if (typeof lastRead !== "number" || !Number.isFinite(lastRead)) {
    // Never opened: any existing message counts as unread.
    return true;
  }
  return latestMessageAt > lastRead;
}

/**
 * Build the accessible label for the unread badge. Text (not colour alone)
 * so screen readers and color-blind users get the same signal.
 */
export function unreadBadgeLabel(count?: number): string {
  if (typeof count === "number" && Number.isFinite(count) && count > 1) {
    return `${count} new messages`;
  }
  return "New message";
}
