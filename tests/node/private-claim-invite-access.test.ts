/**
 * A private claim is only readable with the invite key whose keccak256 matches
 * the `invite_key_hash` the contract stored. Readers are injected, so no RPC.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { getClaimWithAccess, type ClaimData } from "../../lib/contract";
import { inviteKeyHash, inviteKeyMatches } from "../../lib/invite-key";

const KEY = "correct-horse-battery-staple";
const HASH = inviteKeyHash(KEY);

function claim(isPrivate: boolean): ClaimData {
  return { id: 7, is_private: isPrivate, question: "secret question" } as unknown as ClaimData;
}

const deps = (isPrivate: boolean, hash: Uint8Array | null = HASH) => ({
  readClaim: async () => claim(isPrivate),
  readInviteHash: async () => hash,
});

test("keccak256 matches the contract's hash_string for a known vector", () => {
  // keccak256("") — the well-known empty-input digest.
  assert.equal(
    Buffer.from(inviteKeyHash("")).toString("hex"),
    "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
  );
});

test("the right key unlocks a private claim", async () => {
  const result = await getClaimWithAccess(7, KEY, deps(true));
  assert.equal(result?.question, "secret question");
});

test("a wrong but well-formed key is refused", async () => {
  assert.equal(await getClaimWithAccess(7, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", deps(true)), null);
});

test("no key, or a private claim with no stored hash, is refused", async () => {
  assert.equal(await getClaimWithAccess(7, undefined, deps(true)), null);
  assert.equal(await getClaimWithAccess(7, KEY, deps(true, null)), null);
});

test("a public claim is unaffected by the key", async () => {
  assert.equal((await getClaimWithAccess(7, "anything", deps(false)))?.id, 7);
  assert.equal((await getClaimWithAccess(7, undefined, deps(false)))?.id, 7);
});

test("inviteKeyMatches fails closed on malformed input", () => {
  assert.equal(inviteKeyMatches(KEY, HASH), true);
  assert.equal(inviteKeyMatches("", HASH), false);
  assert.equal(inviteKeyMatches(KEY, new Uint8Array(31)), false);
  assert.equal(inviteKeyMatches("x".repeat(129), inviteKeyHash("x".repeat(129))), false);
});
