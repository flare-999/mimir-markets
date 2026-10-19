/**
 * Basket (un)subscribe signatures are bound to their action, a nonce and an
 * expiry, so a captured subscribe signature cannot be replayed or presented as
 * an unsubscribe (and vice versa).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { Keypair } from "@stellar/stellar-sdk";

import { subscriptionMessage } from "../../lib/baskets";
import { SIGNED_ACTION_MAX_TTL_MS, validateSignedWindow } from "../../lib/signed-window";
import { verifyStellarSignedMessage } from "../../lib/stellar-message";

const kp = Keypair.random();
const NOW = 1_800_000_000_000;
const base = {
  basketId: "basket-1",
  subscriber: kp.publicKey(),
  perMarketUsdc: 0,
  nonce: "nonce-aaaaaaaaaaaaaaaa",
  expiresAt: NOW + 60_000,
};

function sign(message: string): string {
  return kp.sign(Buffer.from(message, "utf8")).toString("base64");
}

test("subscribe and unsubscribe messages differ, so signatures are not interchangeable", () => {
  const subscribe = subscriptionMessage({ ...base, action: "subscribe" });
  const unsubscribe = subscriptionMessage({ ...base, action: "unsubscribe" });
  assert.notEqual(subscribe, unsubscribe);

  const subscribeSig = sign(subscribe);
  assert.equal(verifyStellarSignedMessage({ address: kp.publicKey(), message: subscribe, signature: subscribeSig }), true);
  assert.equal(verifyStellarSignedMessage({ address: kp.publicKey(), message: unsubscribe, signature: subscribeSig }), false);
});

test("the nonce and expiry are part of the signed text", () => {
  const signed = sign(subscriptionMessage({ ...base, action: "subscribe" }));
  const otherNonce = subscriptionMessage({ ...base, action: "subscribe", nonce: "nonce-bbbbbbbbbbbbbbbb" });
  const otherExpiry = subscriptionMessage({ ...base, action: "subscribe", expiresAt: base.expiresAt + 1 });
  assert.equal(verifyStellarSignedMessage({ address: kp.publicKey(), message: otherNonce, signature: signed }), false);
  assert.equal(verifyStellarSignedMessage({ address: kp.publicKey(), message: otherExpiry, signature: signed }), false);
});

test("signed window: nonce shape and expiry bounds", () => {
  assert.equal(validateSignedWindow(undefined, NOW + 1_000, NOW).ok, false);
  assert.equal(validateSignedWindow("short", NOW + 1_000, NOW).ok, false);
  const expired = validateSignedWindow(base.nonce, NOW, NOW);
  assert.equal(expired.ok, false);
  assert.equal(expired.ok ? "" : expired.code, "request_expired");
  assert.equal(validateSignedWindow(base.nonce, NOW + SIGNED_ACTION_MAX_TTL_MS + 1, NOW).ok, false);
  assert.equal(validateSignedWindow(base.nonce, "123", NOW).ok, false);
  const ok = validateSignedWindow(` ${base.nonce} `, NOW + SIGNED_ACTION_MAX_TTL_MS, NOW);
  assert.deepEqual(ok, { ok: true, nonce: base.nonce, expiresAt: NOW + SIGNED_ACTION_MAX_TTL_MS });
});
