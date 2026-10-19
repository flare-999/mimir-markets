/**
 * Server entry point for subscription passes. The logic lives in
 * `lib/paid-pass.ts` so it can be unit-tested outside a React server context.
 */

import "server-only";

export { issuePass, verifyPass, type PassClaims } from "../paid-pass";
