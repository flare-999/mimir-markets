"use client";

/**
 * Browser side of analytics — a thin, dependency-free poster to
 * /api/analytics/event. No SDK ships to the client, and the actor salt stays on
 * the server (see ./server.ts for why).
 *
 * Consent is checked here so a non-consenting user makes no network call at all,
 * and enforced again server-side so a stale tab"cannot bypass it.
 */

import type { AnalyticsEvent, EventEnvelope, EventProperties } from "./events";

const CONSENT_KEY = "mimir.analytics.consent";

export type ConsentState = "granted" | "denied" | "unset";

/** Browser "Do Not Track" / Global Privacy Control. Treated as a hard denial. */
function browserOptOut(): boolean {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & { doNotTrack?: string; globalPrivacyControl?: boolean };
  if (nav.globalPrivacyControl === true) return true;
  const dnt = nav.doNotTrack ?? (window as unknown as { doNotTrack?: string }).doNotTrack;
  return dnt === "1" || dnt === "yes";
}

export function getConsent(): ConsentState {
  if (browserOptOut()) return "denied";
  try {
    const stored = window.localStorage.getItem(CONSENT_KEY);
    return stored === "granted" || stored === "denied" ? stored : "unset";
  } catch {
    // Private mode / blocked storage: no consent record means no tracking.
    return "unset";
  }
}

export function setConsent(state: Exclude<ConsentState, "unset">): void {
  try {
    window.localStorage.setItem(CONSENT_KEY, state);
  } catch {
    /* nothing to persist to; the in-page default stays "unset" */
  }
}

/**
 * Analytics requires an explicit grant. "unset" does not track — an unanswered
 * banner is not consent.
 */
export function mayTrack(): boolean {
  return getConsent() === "granted";
}

export interface TrackArgs {
  event: AnalyticsEvent;
  envelope: Partial<EventEnvelope> & Pick<EventEnvelope, "source_surface">;
  properties?: EventProperties;
  /** Connected wallet, if any. Hashed server-side; never stored by analytics. */
  address?: string | null;
  /** Deduplicates a step the user can trigger twice (double-click, remount). */
  idempotencyKey?: string;
}

/**
 * Fire an event. Never throws and never blocks the UI — a failed analytics call
 * must not surface to the user.
 */
export function track(args: TrackArgs): void {
  if (typeof window === "undefined" || !mayTrack()) return;

  const payload = JSON.stringify({
    event: args.event,
    envelope: { ...args.envelope, locale: args.envelope.locale ?? document.documentElement.lang },
    properties: args.properties,
    address: args.address ?? null,
    idempotencyKey: args.idempotencyKey,
  });

  // keepalive so an event fired during navigation still leaves the page.
  void fetch("/api/analytics/event", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: payload,
    keepalive: true,
  }).catch(() => {
    /* analytics is best-effort */
  });
}
