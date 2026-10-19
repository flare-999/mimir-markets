import { NextResponse } from "next/server";

import { apiError } from "@/lib/api/errors";
import { getVsFeedSnapshot } from "@/lib/server/vs-index";
import { VS_CACHE_HEADERS } from "@/lib/server/vs-cache";

export const dynamic = "force-dynamic";

export function computeVsEtag(updatedAt: string | number | null | undefined, count: number): string {
  const maxUpdatedAt = updatedAt == null ? "0" : String(updatedAt);
  return `W/"${maxUpdatedAt}-${count}"`;
}

export function isEtagMatch(ifNoneMatch: string | null, ifNoneMatchWeak: string | null, etag: string): boolean {
  const header = ifNoneMatch ?? ifNoneMatchWeak;
  if (!header) return false;
  const tokens = header.split(",").map((t) => t.trim());
  if (tokens.includes("*")) return true;
  const normalize = (value: string) => value.replace(/^W\//, "");
  const target = normalize(etag);
  return tokens.some((t) => normalize(t) === target);
}

function resolveMaxUpdatedAt(items: Array<Record<string, unknown>>): string | number | null {
  let max: string | number | null = null;
  for (const item of items) {
    const value = item.updated_at as string | number | null | undefined;
    if (value == null) continue;
    if (max === null || value > max) max = value;
  }
  return max;
}

export async function GET(request: Request) {
  try {
    const { authorizeRequest } = await import("@/lib/api/policy");
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || undefined;
    const gate = authorizeRequest("public_read", { route: "/api/vs", ip });
    if (!gate.allowed && gate.error) {
      return NextResponse.json(gate.error.body, { status: gate.error.status, headers: gate.error.headers });
    }
    const { searchParams } = new URL(request.url);
    const refreshValue = searchParams.get("refresh");
    const cursorValue = searchParams.get("cursor");
    const limitValue = searchParams.get("limit");

    if (refreshValue && refreshValue !== "1") {
      const err = apiError("invalid_request", "refresh must be 1 when provided", { field: "refresh" });
      return NextResponse.json(err.body, { status: err.status, headers: err.headers });
    }

    const shouldRefresh = refreshValue === "1";
    const cursor = cursorValue ? Number(cursorValue) : undefined;
    const limit = limitValue ? Number(limitValue) : undefined;

    if (cursor !== undefined && (isNaN(cursor) || cursor <= 0)) {
      const err = apiError("invalid_request", "cursor must be a positive integer", { field: "cursor" });
      return NextResponse.json(err.body, { status: err.status, headers: err.headers });
    }
    if (limit !== undefined && (isNaN(limit) || limit <= 0 || limit > 100)) {
      const err = apiError("invalid_request", "limit must be between 1 and 100", { field: "limit" });
      return NextResponse.json(err.body, { status: err.status, headers: err.headers });
    }

    const { items, cache, nextCursor } = await getVsFeedSnapshot({
      forceRefresh: shouldRefresh,
      cursor,
      limit,
    });

    const maxUpdatedAt = resolveMaxUpdatedAt(items as Array<Record<string, unknown>>);
    const etag = computeVsEtag(maxUpdatedAt, items.length);
    const ifNoneMatch = request.headers.get("if-none-match");

    if (isETagMatch(ifNoneMatch, null, etag)) {
      return new NextResponse(null, {
        status: 304,
        headers: { ...VS_CACHE_HEADERS, ETag: etag },
      });
    }

    return NextResponse.json(
      {
        items,
        count: items.length,
        cache,
        nextCursor,
      },
      {
        headers: { ...VS_CACHE_HEADERS, ETag: etag },
      }
    );
  } catch {
    const err = apiError("internal_error", "Unable to load VS feed");
    return NextResponse.json(err.body, { status: err.status, headers: err.headers });
  }
}
