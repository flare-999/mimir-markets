import { NextResponse } from "next/server";

import {
  parseInviteKey,
  parsePositiveIntegerParam,
} from "@/lib/server/api-validation";
import { apiError } from "@/lib/api/errors";
import { authorizeRequest } from "@/lib/api/policy";
import { triggerPostWriteRefresh } from "@/lib/server/vs-index";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const ROUTE = "/api/vs/sync";

/** How long a claim stays in cooldown after a refresh. */
const COOLDSOWN_MS = 15_000;

const cooldowns = new Map<number, number>();

function inCooldown(claimId: number, now = Date.now()): boolean {
  const expiresAt = cooldowns.get(claimId);
  if (expiresAt === undefined) return false;
  if (expiresAt <= now) {
    cooldowns.delete(claimId);
    return false;
  }
  return true;
}

function markRefreshed(claimId: number, now = Date.now()): void {
  cooldowns.set(claimId, now + COOLDOWN_MS);
}

function clientIp(request: Request): string | undefined {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return request.headers.get("x-real-ip") ?? undefined;
}

type RefreshBody = {
  claimId?: number;
  inviteKey?: string | null;
};

export async function POST(request: Request) {
  let payload: RefreshBody;
  try {
    payload = (await request.json()) as RefreshBody;
  } catch {
    const err = apiError("invalid_request", "invalid JSON");
    return NextResponse.json(err.body, { status: err.status, headers: err.headers });
  }

  try {
    const auth = authorizeRequest("public_read", {
      route: ROUTE,
      ip: clientIp(request),
    });
    if (!auth.allowed && auth.error) {
      return NextResponse.json(auth.error.body, {
        status: auth.error.status,
        headers: auth.error.headers,
      });
    }

    const payload = (await request.json()) as RefreshBody;
    const claimId = parsePositiveIntegerParam(
      payload.claimId == null ? undefined : String(payload.claimId)
    );

    if (!claimId) {
      const err = apiError("invalid_request", "Invalid claim id", { field: "claimId" });
      return NextResponse.json(err.body, { status: err.status, headers: err.headers });
    }

    const inviteKey = parseInviteKey(payload.inviteKey ?? null);
    if (inviteKey === null) {
      const err = apiError("invalid_request", "Invalid invite key", { field: "inviteKey" });
      return NextResponse.json(err.body, { status: err.status, headers: err.headers });
    }

    // A repeated refresh of the same claim inside the cooldown is accepted
    // but does not touch the chain: the index is already warm.
    if (inCooldown(claimId)) {
      return NextResponse.json(
        { indexed: false },
        { status: 202, headers: { "Cache-Control": "no-store" } }
      );
    }

    markRefreshed(claimId);

    const claim = await triggerPostWriteRefresh({
      claimId,
      inviteKey,
    });

    return NextResponse.json(
      {
        indexed: Boolean(claim),
      },
      {
        status: claim ? 200 : 202,
        headers: {
          "Cache-Control": "no-store",
        },
      }
    );
  } catch {
    const err = apiError("internal_error", "Unable to refresh VS index");
    return NextResponse.json(err.body, { status: err.status, headers: err.headers });
  }
}
