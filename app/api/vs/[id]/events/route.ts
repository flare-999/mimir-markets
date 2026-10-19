import { NextRequest, NextResponse } from "next/server";

import {
  parseInviteKey,
  parsePositiveIntegerParam,
} from "@/lib/server/api-validation";
import { apiError } from "@/lib/api/errors";
import {
  detectVsIndexChange,
  formatSseComment,
  formatSseEvent,
  formatSseRetry,
  SSE_HEARTBEAT_INTERVAL_MS,
  SSE_MAX_DURATION_MS,
  SSE_POLL_INTERVAL_MS,
  SSE_RETRY_MS,
  type VsIndexFingerprint,
} from "@/lib/vs-events";
import { getVsIndexFingerprint } from "@/lib/server/vs-events";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const vsId = parsePositiveIntegerParam(id);
    if (!vsId) {
      const err = apiError("invalid_request", "Invalid VS id", { field: "id" });
      return NextResponse.json(err.body, { status: err.status, headers: err.headers });
    }

    const inviteKey = parseInviteKey(
      new URL(request.url).searchParams.get("invite")
    );
    if (inviteKey === null) {
      const err = apiError("invalid_request", "Invalid invite key", { field: "invite" });
      return NextResponse.json(err.body, { status: err.status, headers: err.headers });
    }

    const encoder = new TextEncoder();
    let pollIntervalId: NodeJS.Timeout | null = null;
    let heartbeatIntervalId: NodeJS.Timeout | null = null;
    let maxDurationTimeoutId: NodeJS.Timeout | null = null;
    let isStreamClosed = false;

    const stream = new ReadableStream({
      async start(controller) {
        function cleanup() {
          if (isStreamClosed) return;
          isStreamClosed = true;
          if (pollIntervalId) {
            clearInterval(pollIntervalId);
            pollIntervalId = null;
          }
          if (heartbeatIntervalId) {
            clearInterval(heartbeatIntervalId);
            heartbeatIntervalId = null;
          }
          if (maxDurationTimeoutId) {
            clearTimeout(maxDurationTimeoutId);
            maxDurationTimeoutId = null;
          }
        }

        function safeSend(text: string) {
          if (isStreamClosed) return;
          try {
            controller.enqueue(encoder.encode(text));
          } catch {
            cleanup();
          }
        }

        function safeClose() {
          if (isStreamClosed) return;
          cleanup();
          try {
            controller.close();
          } catch {
            // Already closed
          }
        }

        request.signal.addEventListener("abort", () => {
          cleanup();
          try {
            controller.close();
          } catch {
            // Already closed
          }
        });

        // 1. Send client reconnection delay and connection acknowledgement
        safeSend(formatSseRetry(SSE_RETRY_MS));
        safeSend(formatSseComment("connected"));

        // 2. Read initial index fingerprint
        let lastFingerprint: VsIndexFingerprint | null = await getVsIndexFingerprint(vsId);

        // 3. Cheap index polling loop
        pollIntervalId = setInterval(async () => {
          if (isStreamClosed) return;
          try {
            const currentFingerprint = await getVsIndexFingerprint(vsId);
            if (!currentFingerprint) return;

            const change = detectVsIndexChange(lastFingerprint, currentFingerprint);
            if (change.hasChanged) {
              lastFingerprint = currentFingerprint;
              const payload = {
                type: "change",
                claimId: vsId,
                updatedAt: currentFingerprint.updatedAt,
                reasoningCount: currentFingerprint.reasoningCount,
                reason: change.reason,
              };
              safeSend(formatSseEvent("message", payload));
            }
          } catch {
            // Drop transient query errors without terminating the stream
          }
        }, SSE_POLL_INTERVAL_MS);

        // 4. Periodic keep-alive heartbeats to prevent proxy/gateway timeouts
        heartbeatIntervalId = setInterval(() => {
          if (isStreamClosed) return;
          safeSend(formatSseComment("heartbeat"));
        }, SSE_HEARTBEAT_INTERVAL_MS);

        // 5. Cleanly close connection at max duration so the client reconnects
        maxDurationTimeoutId = setTimeout(() => {
          safeClose();
        }, SSE_MAX_DURATION_MS);
      },
      cancel() {
        if (!isStreamClosed) {
          isStreamClosed = true;
          if (pollIntervalId) clearInterval(pollIntervalId);
          if (heartbeatIntervalId) clearInterval(heartbeatIntervalId);
          if (maxDurationTimeoutId) clearTimeout(maxDurationTimeoutId);
        }
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch {
    const err = apiError("internal_error", "Unable to open events stream");
    return NextResponse.json(err.body, { status: err.status, headers: err.headers });
  }
}
