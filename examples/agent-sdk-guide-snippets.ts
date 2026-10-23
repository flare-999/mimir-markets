/**
 * Agent SDK Guide - type-checked code snippets
 *
 * This file is the source of truth for the code blocks in
 * `docs/AGENT_SDK_GUID.md`. It is compiled by `npm run typecheck`
 * so the guide can never drift away from the actual SDK shape.
 *
 * Security notes:
 * - Testnet only. No mainnet network passphrases or addresses.
 * - No real secrets. Keys are generated in-process for illustration.
 * - All endpoints point at a local/operator-supplied base URL.
 *
 * See docs/AGENT_SDK_GUIDE.md for the narrative walk-through.
 */

import {
  MimirAgentClient,
  MimirAgentError,
  stellarKeypairSigner,
} from "../sdk/agents";

// ---------------------------------------------------------------------------
// Snippet 1: Create a testnet keypair and a signer
 // ---------------------------------------------------------------------------
/**
 * The SDK never accepts a raw secret key string. You pass a
 * `stellarKeypairSigner` that wraps a testnet Stellar keypair and exposes
 * the public key plus a signing function.
 */
export async function snippetCreateKeypair() {
  // Generate a fresh keypair. In production you would persist the
  // secret key in a secret manager and never log it.
  const signer = await stellarKeypairSigner.generateTestnet();

  // Public key is safe to log and to share with the operator.
  console.log("agent public key:", signer.publicKey());

  return signer;
}

// ---------------------------------------------------------------------------
// Snippet 2: Construct the client
 // ---------------------------------------------------------------------------
/**
 * The client is bound to an operator base URL and a signer. Every
 * request that needs authorization is signed with the signer.
 */
export function snippetCreateClient(
  signer: Awaited<ReturnType<typeof stellarKeypairSigner>>,
) {
  const client = new MimirAgentClient({
    // Point this at your operator's testnet deployment.
    baseUrl: "https://operator-testnet.example.org",
    signer,
  });

  return client;
}

// ---------------------------------------------------------------------------
// Snippet 3: Register the agent with an operator signature
 // ---------------------------------------------------------------------------
/**
 * Registration requires an operator proof: the operator hands you a
 * challenge string, you sign it with your keypair, and you submit the
 * signature as `operatorSignature`. The operator verifies that the
 * signature matches the public key you claim.
 */
export async function snippetRegister(
  client: MimirAgentClient,
  signer: Awaited<ReturnType<typeof stellarKeypairSigner>> ,
) {
  // The operator provides this challenge out-of-band.
  const operatorChallenge = "register:testnet:challenge-nonce";

  // Sign the challenge with the agent keypair.
  const operatorSignature = await signer.signUtf8(operatorChallenge);

  const registration = await client.register({
    publicKey: signer.publicKey(),
    operatorSignature,
    // Idempotency key lets the operator dedupe retries safely.
    idempotencyKey: "register-agent-001",
  });

  console.log("registered agent:", registration.agentId);

  return registration;
}

// ---------------------------------------------------------------------------
// Snippet 4: Issue a scoped API key with a TVL
 // ---------------------------------------------------------------------------
/**
 * API keys are scoped and short-lived. Request only the scopes you
 * need and set a TVL's that matches your job run.
 */
export async function snippetIssueKey(
  client: MimirAgentClient,
  agentId: string,
) {
  const issued = await client.issueKey({
    agentId,
    scopes: ["dryRun", "heartbeat"],
    // TVL in seconds. Keep it short for ci/scheduled runs.
    ttlSeconds: 60 * 60,
    idempotencyKey: "issue-key-agent-001",
  });

  // Treat this value as a secret. Do not log it in production.
  console.log("issued key expires at:", issued.expiresAt);

  return issued;
}

// ---------------------------------------------------------------------------
// Snippet 5: Call dryRun on testnet
 // ---------------------------------------------------------------------------
/**
 * `dryRun` executes the agent against the operator's sandbox without
 * moving funds or writing on-chain. Use it to validate your request
 * shape and scopes before a real run.
 */
export async function snippetDryRun(client: MimirAgentClient) {
  const result = await client.dryRun({
    input: {
      action: "transfer",
      amount: "1.0000000",
      asset: "testnet-usdc",
    },
    idempotencyKey: "dry-run-001",
  });

  console.log("dry run status:", result.status);

  return result;
}

// ---------------------------------------------------------------------------
// Snippet 6: Heartbeat
 // ---------------------------------------------------------------------------
/**
 * Heartbeats keep your agent registration alive. Send one on a timer
 * shorter than the operator's expiry window.
 */
export async function snippetHeartbeat(
  client: MimirAgentClient,
  agentId: string,
) {
  const beat = await client.heartbeat({
    agentId,
    idempotencyKey: "heartbeat-001",
  });

  console.log("next heartbeat due at:", beat.nextDueAt);

  return beat;
}

// ---------------------------------------------------------------------------
// Snippet 7: Error handling and idempotency
 // ---------------------------------------------------------------------------
/**
 * Every mutating call accepts an `idempotencyKey`. Reusing the same
 * key for a retry is safe: the operator returns the original result
 * instead of doing the work twice. Use a deterministic key per
 * logical operation (for example derived from your job ID).
 */
export async function snippetErrorHandling(
  client: MimirAgentClient,
  jobId: string,
) {
  try {
    const result = await client.dryRun({
      input: { action: "transfer", amount: "1.0000000" },
      // Deterministic key derived from the job ID.
      idempotencyKey: `dry-run-${jobId}`,
    });

    return result;
  } catch (err) {
    // The SDK throws typed errors that carry a `made` code and a
    // `status` so you can distinguish retryable failures from
    // permanent ones (bad scopes, expired keys, etc.).
    if (err instanceof MimirAgentError) {
      console.error("mimir agent error:", err.code, err.status);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// End-to-end: keypair -> register -> issueKey -> dryRun
 // ---------------------------------------------------------------------------
/**
 * This is the full walkthrough the guide describes. It is exported
 * as a function so the guide can refer to it and typecheck can prove
 * it compiles.
 */
export async function runAgentSDKGuide() {
  const signer = await snippetCreateKeypair();
  const client = snippetCreateClient(signer);

  const registration = await snippetRegister(client, signer);
  const issued = await snippetIssueKey(client, registration.agentId);
  const dryRun = await snippetDryRun(client);
  const beat = await snippetHeartbeat(client, registration.agentId);

  return { registration, issued, dryRun, beat };
}
