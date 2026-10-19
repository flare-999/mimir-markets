/**
 * Council pass — one payment buys a window of free council reads.
 *
 * POST /api/council/subscribe   ($0.01 USDC → platform seller)
 *   → { pass, expiresAt, plan }
 *
 * Pass the returned token to /api/council/reasoning?...&pass=<pass> and reads are
 * free until it expires (default 10 min). This is the bundled-access tier on top
 * of the per-read payment; it is deliberately NOT a recurring subscription —
 * per-request x402 and real recurring billing are separate payment products.
 * Unpaid → PAYMENT-REQUIRED 402.
 */

import { NextResponse, type NextRequest } from "next/server";
import { paidRoute, paymentPayer } from "@/lib/x402/server";
import { PRICES } from "@/lib/x402/config";
import { issuePass } from "@/lib/server/paid-pass";

const PLAN = "council";
const TTL_MS = Number(process.env.COUNCIL_PASS_TTL_MS ?? 10 * 60 * 1000);

async function handler(req: NextRequest): Promise<NextResponse> {
  // Bind the pass to whoever signed the payment the paywall just verified.
  const payer = paymentPayer(req);
  if (!payer) {
    return NextResponse.json({ error: "could not read payer from payment" }, { status: 400 });
  }
  const { pass, expiresAt } = issuePass(payer, PLAN, TTL_MS);
  return NextResponse.json({
    plan: PLAN,
    payer,
    pass,
    expiresAt,
    ttlMs: TTL_MS,
    price: PRICES.councilSubscribe,
  });
}

export const POST = paidRoute("councilSubscribe", handler);
