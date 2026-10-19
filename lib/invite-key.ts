/**
 * Off-chain check of a private claim's invite key.
 *
 * The market contract stores `keccak256(utf8(inviteKey))` as
 * `MarketConfig.invite_key_hash` (`util::hash_string` in mimir-market), so the
 * same digest is recomputed here and compared in constant time. Pure, browser
 * safe and dependency-light so it can be unit-tested without an RPC.
 *
 * Design note: the claim text itself is stored on chain in plaintext, so this
 * gate protects the API and UI, not the ledger. Anyone reading `get_claim` from
 * Soroban RPC still sees the content; hiding it would need an on-chain
 * commitment or ciphertext instead of plaintext fields.
 */

import { keccak_256 } from "@noble/hashes/sha3";

/** Same bound as the contract's `MAX_INVITE_KEY_BYTES`. */
export const MAX_INVITE_KEY_BYTES = 128;

/** keccak256 of the UTF-8 invite key, as the contract computes it. */
export function inviteKeyHash(inviteKey: string): Uint8Array {
  return keccak_256(new TextEncoder().encode(inviteKey));
}

/**
 * True only when `inviteKey` hashes to `expected`. A missing expected hash,
 * an empty key or an over-long key is never a match (fail closed).
 */
export function inviteKeyMatches(
  inviteKey: string | null | undefined,
  expected: Uint8Array | null | undefined,
): boolean {
  if (!inviteKey || !expected || expected.length !== 32) return false;
  if (new TextEncoder().encode(inviteKey).length > MAX_INVITE_KEY_BYTES) return false;
  const supplied = inviteKeyHash(inviteKey);
  // Constant-time compare without node:crypto, so this module stays importable
  // from code that is also bundled for the browser.
  let diff = 0;
  for (let i = 0; i < 32; i += 1) diff |= supplied[i] ^ expected[i];
  return diff === 0;
}
