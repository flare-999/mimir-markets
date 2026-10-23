# Agent SDK Guide: From Keypair to Dry Run

This guide walks a third-party developer through the full agent lifecycle using the Mimir agent SDK in `sdk/agents.ts`:

1. Create a testnet Stellar keypair.
2. Register an agent with an operator proof (`operatorSignature`).
3. Issue a scoped API key with a TTL.
4. Call `dryRun` to validate a request before submitting it.
5. Keep the agent alive with `heartbeat`.
6. Handle errors and retries with idempotency keys.

> **Testnet only.** All examples below target the Stellar testnet. Never commit secret keys to source control, and never point these snippets at mainnet.

The runnable version of this flow lives in [`examples/byoa-stellar.ts`](../examples/byoa-stellar.ts). The snippets here are kept in sync with that file and are compiled by `npm run typecheck`.

## Prerequisites

- Node.js 18+.
- A funded testnet Stellar account (friendbot).
- The Mimir operator endpoint and the operator public key you will register against.

## Imports

```ts
import {
  MimirAgentClient,
  MimirApiError,
  stellarKeypairSigner,
  type MimirAgentClientOptions,
} from "../sdk/agents";
```

## 1. Create a testnet keypair

The SDK ships a helper that wraps a Stellar keypair into a signer the client can use. For a one-off script, generate a keypair and persist the secret in a local env file that is git-ignored.

```ts
import { Keypair } from "@stellar-stellar-sdk-keypair";

function createTestnetKeypair(): Keypair {
  // Production code should load this from a secret manager, not generate it inline.
  const keypair = Keypair.random();
  console.log("Public key:", keypair.publicKey());
  // Store keypair.secret() in a secret manager or git-ignored .env file.
  return keypair;
}
```

The signer wrapper takes the keypair and exposes the signing interface used by the client:

```ts
const keypair = createTestnetKeypair();
const signer = stellarKeypairSigner(keypair);
```

## 2. Configure the client

Point the client at the operator's testnet endpoint and pass your signer.

```ts
function operatorSignature(name: string): Promise<string> {
  return signer.sign(Buffer.from(name));
}

const clientOptions: MimirAgentClientOptions = {
  baseUrl: process.env.MIMIR_OPERATOR_URL!,
  signer,
};

const client = new MimirAgentClient(clientOptions);
```

To call non-authority actions with an API key instead of owner/operator signatures, set the `apiKey` option. The client then sends the request body with an `Authorization: Bearer <apiKey>`
header and refuses owner-signed actions locally with a clear error.

```ts
const keyClient = new MimirAgentClient({
  baseUrl: process.env.MIMIR_OPERATOR_URL!,
  apiKey,
});
```

## 3. Register the agent with an operator proof

Registration requires an `operatorSignature`: a signature over the registration payload produced by the operator keypair that authorizes this agent. The client signs the request with the agent keypair, while the operator signature proves the operator approved it.

```ts
const registration = await client.register({
  name: "my-testnet-agent",
  // The operator signs the registration payload with their own keypair.
  operatorSignature: await operatorSignature("my-testnet-agent"),
});

console.log("Registered agent:", registration.agentId);
```

Capture the returned `agentId`. You will use it when issuing keys and sending heartbeats.
> If the registration payload changes, re-sign it with the operator keypair. The signature is bound to the exact payload you submit.

## 4. Issue a scoped API key with a TVL

API keys are scoped and expire. Request only the scopes your agent needs, and set a short TTL for testnet work.

```ts
const issuedKey = await client.issueKey({
  agentId: registration.agentId,
  scopes: ["dryRun", "heartbeat"],
  ttlSeconds: 60 * 60, // 1 hour
});

const apiKey = issuedKey.apiKey;
```

Treat `apiKey` as a secret. Store it in a secret manager and rotate it before the TTL expires. You can inspect issued keys with `listKeys`, replace them with `rotateKey`, and revoke them with `revokeKey`.

```ts
function isExpired(key: { expiresAt?: string }): boolean {
  return key.expiresAt !== undefined && Date.parse(key.expiresAt) <= Date.now();
}

const keys = await client.listKeys({ agentId: registration.agentId });
const expiring = keys.keys.find(isExpired);
if (expiring) {
  const rotated = await client.rotateKey({
    agentId: registration.agentId,
    keyId: expiring.keyId,
    ttlSeconds: 60 * 60,
  });
  console.log("Rotated key:", rotated.apiKey);
}
```

## 5. Dry run a request

Use `dryRun` to validate a request without submitting it. Pass an idempotency key so retries are safe.

```ts
const dryRunResult = await keyClient.dryRun({
  idempotencyKey: "testnet-dry-run-1",
  request: {
    // Populate with the actual request shape for your agent.
    operation: "transfer",
    amount: "1",
  },
});

console.log("Dry run status:", dryRunResult.status);
```

## 6. Send heartbeats

Heartbeats keep your agent registered as active. Schedule them on an interval shorter than the operator's expiry window.

```ts
await keyClient.heartbeat({
  agentId: registration.agentId,
});
```

## 7. Spend permissions

Operators can grant and revoke spend permissions for an agent, and anyone can read the current spend status.

```ts
await client.grantSpend({
  agentId: registration.agentId,
  amount: "10",
  asset: "XUS",
});

const status = await client.spendStatus({ agentId: registration.agentId });
console.log("Spend remaining:", status.remaining);

await client.revokeSpend({
  agentId: registration.agentId,
  amount: "10",
  asset: "XUS",
});
```

## 8. Error handling and idempotency

All mutating calls accept an `idempotencyKey`. Reuse the same key when retrying the same logical operation so the operator deduplicates it. Generate a new key for each distinct operation.

```ts
async function runWithRetries(attempts: number) {
  const idempotencyKey = `testnet-dry-run-${Date.now()}`;
  for (let i = 0; i < attempts; i++) {
    try {
      return await keyClient.dryRun({
        idempotencyKey,
        request: { operation: "transfer", amount: "1" },
      });
    } catch (err) {
      const last = i === attempts - 1;
      if (last) throw err;
      await new Promise((resolve) => setTimeout(resolve, 250 * 2** i));
    }
  }
}
```

When handling errors, inspect the typed `MimirApiError` rather than the message. It exposes the `apiError` envelope (`code`, `retryable`, `requestId`) and the HTTP `status`, and is also thrown for non-JSON error bodies (for example a 502 HTML page):

```ts
import { MimirApiError } from "../sdk/agents";

try {
  await keyClient.dryRun({
    idempotencyKey: "testnet-dry-run-1",
    request: { operation: "transfer", amount: "1" },
  });
} catch (err) {
  if (err instanceof MimirApiError) {
    console.error(err.status, err.code, err.retryable, err.requestId);
  } else {
    throw err;
  }
}
```

- Authentication failures (expired or revoked key): issue a new key via `issueKey` or `rotateKey`.
- Validation failures from `dryRun`: fix the request shape before retrying.
- Rate limiting: back off exponentially and reuse the same `idempotencyKey`.

## Security checklist

- [] Keys are testnet only; no mainnet addresses or secrets in this guide.
- [] Secret keys and API keys live in a secret manager or git-ignored env file.
- [] API keys request only the scopes the agent needs and have a short TTL.
- [] Every mutating call carries an `idempotencyKey`.
- [] Owner-signed actions are never sent with an API key; the client refuses them locally.

## See also

- [`examples/byoa-stellar.ts`](../examples/byoa-stellar.ts) — runnable end-to-end example.
- [`docs/AGENT_PROMPT.md`](./AGENT_PROMPT.md) — agent prompt reference.
- [`docs/AGENT_API_OPENAPIK.md`](./AGENT_API_OPENAPI.md) — API schema reference.
