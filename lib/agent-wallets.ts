/**
 * Stellar keypair wallets for the Mimir worker agents (oracle, market-creator,
 * council personas, philosophers, demo traders).
 *
 * Each agent owns a plain Stellar account whose secret seed lives only in the
 * worker process env — the web server never sees a seed, it only knows the
 * public `G…` keys (`COUNCIL_<SLUG>_PUBLIC` etc.) for payment routing and
 * display.
 *
 * Env contract (workers only), matching the `STELLAR_DEPLOYER_SECRET` /
 * `STELLAR_ORACLE_SECRET` convention `deploy/deploy.ts` already established:
 *
 *   ORACLE_SECRET=S…                  → oracle agent
 *   CREATOR_SECRET=S…                 → market-creator agent
 *   COUNCIL_<SLUG>_SECRET=S…          → each council persona / philosopher
 *   TRADER_<NAME>_SECRET=S…           → each demo trader
 *
 * Generate the whole fleet:  npm run agents:create-wallets
 * Fund it:                   npm run agents:fund
 *
 * ── What changed versus the EVM version this replaces ────────────────────────
 *
 *  - **No allowance, so no `agentContractWrite`.** The old helper's whole reason
 *    to exist was wrapping "approve USDC, then call the contract, then wait for a
 *    receipt". Soroban authorises per invocation: `challenge_claim` carries an
 *    auth entry permitting exactly one USDC transfer of exactly the stake. Agents
 *    therefore call the typed helpers in `lib/contract.ts` directly with
 *    `wallet.signer` and there is nothing left for a generic write wrapper to do.
 *  - **`signAuthEntry` is not optional here.** Every staking call invokes the USDC
 *    SAC on the agent's behalf, so the agent signs a SorobanAuth entry as well as
 *    the envelope. `basicNodeSigner` provides both, which is why it is used rather
 *    than a bare `sign(tx)`.
 *  - **Gas is not a currency to manage.** A Stellar fee is ~100 stroops
 *    (0.00001 XLM) and Friendbot hands out 10,000 XLM, so "top up the gas
 *    account" collapses into "make sure the account exists". {@link ensureFunded}
 *    is the whole of it.
 */

import { Asset, BASE_FEE, Keypair, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { basicNodeSigner } from "@stellar/stellar-sdk/contract";

import {
  NETWORK_PASSPHRASE,
  STELLAR_NETWORK,
  createHorizonServer,
  isAccountAddress,
  type StellarSigner,
} from "./stellar";
import { USDC_CODE, USDC_ISSUER, formatAtomicUsdc, usdcAsset } from "./usdc";
import { readUsdcTrustline, ensureUsdcTrustline } from "./stellar-trustline";
import { verifyStellarSignedMessage } from "./stellar-message";
import type { StellarAgentWalletAdapter } from "./agents/wallet-adapter";

/** Friendbot only exists on Testnet; it is the funding source for the fleet. */
export const FRIENDBOT_URL =
  process.env.STELLAR_FRIENDBOT_URL?.trim() || "https://friendbot.stellar.org";

export interface AgentWallet {
  keypair: Keypair;
  /** What every write in `lib/contract.ts` wants. Includes `signAuthEntry`. */
  signer: StellarSigner;
  /** The `G…` public key. Named `address` so call sites read unchanged. */
  address: string;
}

/**
 * Env var name for an agent's secret seed.
 *
 * Accepts the bare role (`"ORACLE"`) or the full var (`"ORACLE_SECRET"`) so a
 * caller can pass either without a second helper.
 */
export function secretEnvName(role: string): string {
  const upper = role.toUpperCase().replace(/-/g, "_");
  return upper.endsWith("_SECRET") ? upper : `${upper}_SECRET`;
}

export function publicEnvName(role: string): string {
  const upper = role.toUpperCase().replace(/-/g, "_");
  return upper.endsWith("_PUBLIC") ? upper : `${upper.replace(/_SECRET$/, "")}_PUBLIC`;
}

/**
 * Read and validate a secret seed.
 *
 * `.env` values in this repo carry trailing `# comment` notes and can pick up a
 * stray `\r` from a CRLF file, either of which makes `Keypair.fromSecret` throw
 * about a seed that looks perfectly correct in the logs.
 */
function normalizeSecret(raw: string | undefined, envVar: string): string {
  const value = (raw ?? "").split(/\s+#/)[0].trim();
  if (!value) throw new Error(`${envVar} env var is required`);
  if (!/^S[A-Z2-7]{55}$/.test(value)) {
    throw new Error(`${envVar} must be a Stellar secret seed (S… , 56 chars)`);
  }
  return value;
}

/** Build a wallet from an explicit secret-seed env var. */
export function loadAgentWallet(
  envVar: string,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): AgentWallet {
  const name = secretEnvName(envVar);
  const secret = normalizeSecret(env[name], name);
  let keypair: Keypair;
  try {
    keypair = Keypair.fromSecret(secret);
  } catch {
    throw new Error(`${name} must be a Stellar secret seed (S… , 56 chars)`);
  }
  return walletFromKeypair(keypair);
}

export function walletFromKeypair(keypair: Keypair): AgentWallet {
  const signer = basicNodeSigner(keypair, NETWORK_PASSPHRASE);
  return {
    keypair,
    address: keypair.publicKey(),
    signer: {
      publicKey: keypair.publicKey(),
      signTransaction: signer.signTransaction,
      signAuthEntry: signer.signAuthEntry,
    },
  };
}

export function getOracleWallet(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): AgentWallet {
  return loadAgentWallet("ORACLE_SECRET", env);
}

export function getCreatorWallet(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): AgentWallet {
  return loadAgentWallet("CREATOR_SECRET", env);
}

export function councilEnvSlug(slug: string): string {
  return slug.toUpperCase().replace(/-/g, "_");
}

export function councilSecretEnv(slug: string): string {
  return `COUNCIL_${councilEnvSlug(slug)}_SECRET`;
}

export function councilPublicEnv(slug: string): string {
  return `COUNCIL_${councilEnvSlug(slug)}_PUBLIC`;
}

export function getCouncilWallet(
  slug: string,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): AgentWallet {
  return loadAgentWallet(councilSecretEnv(slug), env);
}

/** Public key of a persona without touching its seed (web-server safe). */
export function getCouncilAddress(
  slug: string,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): string | undefined {
  const value = env[councilPublicEnv(slug)]?.split(/\s+#/)[0].trim();
  return value && isAccountAddress(value) ? value : undefined;
}

// ── Wallet adapter boundary (shared with BYOA wallets) ───────────────────────

/**
 * Put a worker's own keypair behind the same boundary a BYOA wallet uses.
 *
 * `simulate` is a real Soroban simulation of the assembled call: the generated
 * bindings simulate on construction, so building the transaction IS the dry run
 * and a contract error surfaces here rather than after a signature.
 */
export function stellarAgentWalletAdapter(wallet: AgentWallet): StellarAgentWalletAdapter {
  return {
    kind: "keypair",
    address: wallet.address,
    verifySignature: async ({ message, signature }) =>
      verifyStellarSignedMessage({ address: wallet.address, message, signature }),
    simulate: async (call) => {
      try {
        await call.assemble(wallet.signer);
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : "simulation failed" };
      }
    },
    send: async (call) => {
      const assembled = await call.assemble(wallet.signer);
      const sent = await assembled.signAndSend();
      return sent.sendTransactionResponse?.hash ?? "";
    },
  };
}

// ── Funding and balances ─────────────────────────────────────────────────────

/**
 * Make sure an account exists on the ledger, funding it from Friendbot if not.
 *
 * This is the entire replacement for the EVM "distribute gas" concept. An
 * account needs XLM for two reasons only: the base reserve that lets it exist at
 * all, and ~0.00001 XLM per operation. Friendbot covers both for the life of a
 * testnet deployment in one call, so there is no ongoing top-up loop to run.
 */
export async function ensureFunded(
  publicKey: string,
): Promise<{ created: boolean; xlm: string }> {
  const horizon = createHorizonServer();
  try {
    const account = await horizon.loadAccount(publicKey);
    const native = account.balances.find((b) => b.asset_type === "native");
    return { created: false, xlm: native?.balance ?? "0" };
  } catch (cause) {
    if ((cause as { response?: { status?: number } })?.response?.status !== 404) throw cause;
  }

  if (STELLAR_NETWORK !== "testnet") {
    throw new Error(
      `${publicKey} does not exist on ${STELLAR_NETWORK} and Friendbot is testnet-only — fund it manually.`,
    );
  }
  const response = await fetch(`${FRIENDBOT_URL}/?addr=${encodeURIComponent(publicKey)}`);
  if (!response.ok) {
    throw new Error(`friendbot ${response.status} for ${publicKey}: ${(await response.text()).slice(0, 300)}`);
  }
  await response.json().catch(() => undefined);
  const account = await horizon.loadAccount(publicKey);
  const native = account.balances.find((b) => b.asset_type === "native");
  return { created: true, xlm: native?.balance ?? "0" };
}

/** Add the USDC trustline to an agent's own account. Idempotent. */
export async function ensureAgentTrustline(
  wallet: AgentWallet,
): Promise<{ added: boolean; hash?: string }> {
  return ensureUsdcTrustline(wallet.signer);
}

export interface AgentBalances {
  /** Display XLM, or null when the account does not exist yet. */
  xlm: number | null;
  /** Display USDC, or null when there is no trustline. */
  usdc: number | null;
  exists: boolean;
  hasTrustline: boolean;
}

/**
 * Native XLM plus the USDC trustline balance, read straight from Horizon.
 *
 * Horizon rather than the SAC balance read in `lib/usdc.ts`: one request answers
 * "does the account exist", "how much XLM" and "is there a trustline", and those
 * three are exactly what a funding script needs to tell apart.
 */
export async function readAgentBalances(address: string): Promise<AgentBalances> {
  if (!isAccountAddress(address)) {
    return { xlm: null, usdc: null, exists: false, hasTrustline: false };
  }
  try {
    const account = await createHorizonServer().loadAccount(address);
    const native = account.balances.find((b) => b.asset_type === "native");
    const line = account.balances.find(
      (b) =>
        "asset_code" in b &&
        b.asset_code === USDC_CODE &&
        "asset_issuer" in b &&
        b.asset_issuer === USDC_ISSUER,
    );
    return {
      xlm: native ? Number(native.balance) : 0,
      usdc: line ? Number(line.balance) : null,
      exists: true,
      hasTrustline: Boolean(line),
    };
  } catch (cause) {
    if ((cause as { response?: { status?: number } })?.response?.status === 404) {
      return { xlm: null, usdc: null, exists: false, hasTrustline: false };
    }
    throw cause;
  }
}

/**
 * Send USDC from an agent wallet.
 *
 * A classic `payment` operation on the `USDC:GBBD47…` asset, not a SAC
 * `transfer` invocation. Both move the same balance — a Stellar Asset Contract
 * and the asset it wraps are one ledger entry — and the classic operation needs
 * no Soroban footprint, no auth entry and no simulation, which makes it the right
 * tool for plain agent-to-agent transfers (bonuses, funding). Contract stakes
 * still go through `lib/contract.ts`, where the transfer is part of the
 * invocation's authorisation.
 *
 * The recipient must already hold a USDC trustline; without one Stellar rejects
 * the payment with `op_no_trust` rather than silently creating one.
 */
export async function transferUsdc(args: {
  wallet: AgentWallet;
  to: string;
  /** Decimal USDC amount, e.g. "5" or "0.0012345". Max 7 decimal places. */
  amountUsdc: string;
}): Promise<string> {
  const to = args.to.trim();
  if (!isAccountAddress(to)) throw new Error(`USDC transfer target is not a Stellar account: ${to}`);

  const line = await readUsdcTrustline(to);
  if (line.status === "unfunded") {
    throw new Error(`${to} does not exist on the ledger — fund it with XLM before sending USDC`);
  }
  if (line.status === "missing") {
    throw new Error(`${to} holds no USDC trustline — it cannot receive USDC yet`);
  }

  const horizon = createHorizonServer();
  const source = await horizon.loadAccount(args.wallet.address);
  const transaction = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.payment({ destination: to, asset: usdcAsset(), amount: args.amountUsdc }),
    )
    .setTimeout(120)
    .build();
  transaction.sign(args.wallet.keypair);
  const result = await horizon.submitTransaction(transaction);
  return result.hash;
}

/**
 * Send native XLM from an agent wallet.
 *
 * Only for the rare case where Friendbot is not the right source (moving a
 * surplus back, or a non-testnet deployment). Routine provisioning should use
 * {@link ensureFunded} instead — asking Friendbot is free and does not drain a
 * funder account.
 */
export async function transferXlm(args: {
  wallet: AgentWallet;
  to: string;
  /** Decimal XLM amount, e.g. "5". Max 7 decimal places. */
  amountXlm: string;
}): Promise<string> {
  const to = args.to.trim();
  if (!isAccountAddress(to)) throw new Error(`XLM transfer target is not a Stellar account: ${to}`);

  const horizon = createHorizonServer();
  const source = await horizon.loadAccount(args.wallet.address);
  const transaction = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.payment({ destination: to, asset: Asset.native(), amount: args.amountXlm }),
    )
    .setTimeout(120)
    .build();
  transaction.sign(args.wallet.keypair);
  const result = await horizon.submitTransaction(transaction);
  return result.hash;
}

/** Render atomic USDC for logs without going through IEEE-754. */
export { formatAtomicUsdc };
