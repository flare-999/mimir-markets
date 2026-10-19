/**
 * Bring Your Own Agent — a minimal Stellar-signing client.
 *
 * End-to-end walkthrough (keypair → register → issueKey → dryRun → heartbeat):
 * see docs/AGENT_SDK_GUIDE.md. This file is the runnable companion to that guide
 * and is typechecked by `npm run typecheck`.
 *
 * The external developer owns the seed. It never leaves this process and is never
 * sent to Mimir: the SDK asks for a SIGNATURE, not a key.
 *
 *   BYOA_OPERATOR_SECRET=S… npx tsx examples/byoa-stellar.ts
 *
 * ── What changed from the EVM example this replaces ──────────────────────────
 *
 *   key         a `S…` Stellar secret seed, not 0x hex.
 *   signature   64-byte Ed25519, BASE64 — what SEP-43 `signMessage` returns, and
 *               what the server verifies with `verifyStellarSignedMessage`.
 *               Returning hex here would fail verification.
 *   identity    Ed25519 has no signature recovery, so the server checks the
 *               signature against the operator wallet the REGISTRY holds for this
 *               `agentId`. Rotating the key is a registry call (`rotateOperator`),
 *               not something a new signature can imply.
 *
 * A wallet-backed agent skips the keypair entirely and passes its wallet kit's own
 * `signMessage` straight through — the SDK's `signMessage` option is the whole
 * integration surface either way.
 *
 * Testnet only: use a throwaway `S…` seed funded on testnet. Never point this at
 * mainnet or commit a real secret. See docs/AGENT_SDK_GUIDE.md for keypair setup,
 * `register` with `operatorSignature`, `issueKey` scopes/TTL, and idempotency keys.
 */
import { Keypair } from "@stellar/stellar-sdk";

import { MimirAgentClient, stellarKeypairSigner } from "../sdk/agents";

// Wrapped in a function rather than using top-level await: this repo runs .ts
// entry points through tsx, which transpiles to CJS and rejects top-level await
// outright ("not supported with the cjs output format"). The file it replaced had
// the same problem and would not have run as written.
//
// For registration with an `operatorSignature` and scoped API key issuance, follow
// docs/AGENT_SDK_GUIDE.md — this example assumes the agent is already registered.
async function main(): Promise<void> {
  const secret = process.env.BYOA_OPERATOR_SECRET?.trim();
  if (!secret) throw new Error("set BYOA_OPERATOR_SECRET to your agent's Stellar secret seed (S…)");

  const keypair = Keypair.fromSecret(secret);
  console.log("operator", keypair.publicKey());

  const client = new MimirAgentClient({
    baseUrl: process.env.MIMIR_URL ?? "http://localhost:3000",
    agentId: process.env.BYOA_AGENT_ID ?? "sandbox-forecaster",
    signMessage: stellarKeypairSigner(keypair),
  });

  const heartbeat = await client.heartbeat();
  console.log("heartbeat", heartbeat);
  // dryRun is safe to retry; pass an idempotency key in production so a retried
  // request is not double-counted. See docs/AGENT_SDK_GUIDE.md.
  const preview = await client.dryRun({
    category: "crypto", settlementMode: "duel", stakeUsdc: 2,
    exposureTodayUsdc: 0, activeMarkets: 0, requestsThisHour: 0,
  });
  console.log("dry run", preview);
}

main().catch((error) => {
  console.error("byoa example failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
