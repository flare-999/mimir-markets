/**
 * lib/server/vs-events.ts
 *
 * Server-side helpers for querying claim index state cheaply (without RPC reads).
 */

import { getClaimById, getReasoningCount, isDbConfigured } from "@/lib/db";
import { getVSByIdFast } from "@/lib/server/vs-cache";
import type { VsIndexFingerprint } from "@/lib/vs-events";

/**
 * Reads a lightweight index fingerprint for a claim without hitting the Soroban chain.
 * Queries only the indexed claim row and active reasoning count from the database.
 */
export async function getVsIndexFingerprint(
  claimId: number
): Promise<VsIndexFingerprint | null> {
  if (isDbConfigured()) {
    try {
      const [claim, reasoningCount] = await Promise.all([
        getClaimById(claimId),
        getReasoningCount(claimId),
      ]);

      if (claim) {
        return {
          claimId,
          updatedAt: claim.updated_at,
          reasoningCount,
        };
      }
    } catch {
      // Degrade gracefully to cache fallback if DB query fails
    }
  }

  // Fallback to memory/file cache if DB is not configured or failed
  try {
    const cached = await getVSByIdFast(claimId);
    if (cached) {
      return {
        claimId,
        updatedAt: null,
        reasoningCount: 0,
      };
    }
  } catch {
    // Ignore cache failure
  }

  return null;
}
