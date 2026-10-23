/*
 * POST /api/analytics/event — the only way a browser event reaches PostHog.
 *
 * Exists so the actor salt never leaves the server (see lib/analytics/server.ts)
 * and so redaction cannot be skipped by a client. Always answers 204: analytics
 * must never surface an error to a user, and a body would only invite clients to
 * branch on it.
 *
 * Traced, because the ingest request is server-side telemetry like any other: a
 * capture that silently stops looks identical to a page nobody visited. Note what
 * the trace id here does and does not mean — it identifies THIS ingest, not the
 * navigation that produced the event. A browser may not assert a trace id of its
 * own, so the one in the response belongs to the server and only a client that
 * already held an id we minted would match it.
 */

import { NextResponse, type NextRequest } from "next/server";
import { capture, type CaptureArgs } from "@/lib/analytics/server";
import { isAnalyticsEvent } from "@/lib/analytics/events";
import { MAX_EVENT_PAYLOAD_BYTES, trimProperties } from "@/lib/analytics/redact";
import { tracedRoute } from "@/lib/ops/trace-http";

export const dynamic = "force-dynamic";

/** Do Not Track / Global Privacy Control at the HTTP layer. */
function serverSideOptOut(req: Request | NextRequest): boolean {
  return req.headers.get("dnt") === "1" || req.headers.get("sec-gpc") === "1";
}

export async function ingest(
  req: Request | NextRequest,
  captureFn: typeof capture = capture,
): Promise<Response> {
  const noContent = new NextResponse(null, { status: 204 });
  if (serverSideOptOut(req)) return noContent;

  const contentLength = req.headers.get("content-length");
  if (contentLength) {
    const parsed = Number.parseInt(contentLength, 10);
    if (Number.isFinite(parsed) && parsed > MAX_EVENT_PAYLOAD_BYTES) {
      return noContent;
    }
  }

  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch {
    return noContent;
  }

  if (Buffer.byteLength(rawBody, "utf8") > MAX_EVENT_PAYLOAD_BYTES) {
    return noContent;
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return noContent;
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return noContent;
  }

  const input = body as {
    event?: string;
    envelope?: Record<string, unknown>;
    properties?: Record<string, unknown>;
    address?: string | null;
    idempotencyKey?: string;
  };

  if (!input.event || !isAnalyticsEvent(input.event)) return noContent;
  const surface = input.envelope?.source_surface;
  if (typeof surface !== "string") return noContent;

  const trimmedProperties = trimProperties(input.properties);

  // A browser client may never assert it is an agent: agent events are captured
  // server-side from the workers, where the identity is actually known. Same for
  // actor_type — the client does not get to label itself.
  await captureFn({
    event: input.event,
    envelope: {
      ...(input.envelope ?? {}),
      actor_type: "human",
      source_surface: surface,
    } as CaptureArgs["envelope"],
    properties: trimmedProperties as CaptureArgs["properties"],
    address: input.address ?? null,
    isAgent: false,
    idempotencyKey: input.idempotencyKey,
    consented: true,
  });

  return noContent;
}

export const POST = tracedRoute("api.analytics.event", (req: NextRequest) => ingest(req));
