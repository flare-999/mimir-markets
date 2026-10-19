/**
 * Guards against EVM-shaped address validation surviving the Stellar migration.
 *
 * A `/^0x[0-9a-fA-F]{40}$/` test does not merely fail to normalise a strkey — it
 * REJECTS every real Stellar address, so any code path gated on one is dead for
 * every actual user while still type-checking and still passing a suite whose
 * fixtures are EVM addresses. These tests use real strkeys so that cannot happen
 * again.
 */

import assert from "node:assert/strict";
import test from "node:test";

const ACCOUNT_A = "GBO43ZBS4RBC2QFDKB23U6TBFEEK47ZLGSXDJSRV2H3PNQK5ZDEYXVLE";
const ACCOUNT_B = "GD2SI5PUEFKC7TONNX7OR72WMYUO7WZDSCDSIVWWXPDIDYW5OP3ETM5D";
const CONTRACT_A = "CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR";
const EVM_ADDRESS = "0x0000000000000000000000000000000000000abc";

test("parseAddressParam accepts both strkey forms verbatim and rejects EVM", async () => {
  const { parseAddressParam } = await import("../../lib/server/api-validation");
  assert.equal(parseAddressParam(ACCOUNT_A), ACCOUNT_A);
  assert.equal(parseAddressParam(CONTRACT_A), CONTRACT_A);
  assert.equal(parseAddressParam(` ${ACCOUNT_A} `), ACCOUNT_A);
  assert.equal(parseAddressParam(EVM_ADDRESS), null);
  // Case matters: a lowercased strkey is a different, invalid string.
  assert.equal(parseAddressParam(ACCOUNT_A.toLowerCase()), null);
});

test("actorIdForAddress hashes a Stellar address and stays case-sensitive", async () => {
  const { actorIdForAddress } = await import("../../lib/analytics/actor");
  const id = actorIdForAddress(ACCOUNT_A, "stellar-address-test-salt");
  assert.ok(id, "a real Stellar account must be hashable into an actor id");
  assert.match(id, /^[0-9a-f]{32}$/);

  // Distinct accounts must not collide, and case-folding must not be applied:
  // folding would map two different strings onto one id.
  assert.notEqual(actorIdForAddress(ACCOUNT_B, "stellar-address-test-salt"), id);
  assert.equal(
    actorIdForAddress(ACCOUNT_A.toLowerCase(), "stellar-address-test-salt"),
    null,
    "a lowercased strkey is not a valid address and must not be hashed",
  );
  assert.equal(actorIdForAddress(EVM_ADDRESS, "stellar-address-test-salt"), null);
});

test("containsRawAddress detects an unredacted Stellar address", async () => {
  const { containsRawAddress } = await import("../../lib/analytics/redact");
  assert.equal(
    containsRawAddress({ wallet: ACCOUNT_A }),
    true,
    "a raw strkey reaching analytics is the leak this guard exists to stop",
  );
  assert.equal(containsRawAddress({ wallet: CONTRACT_A }), true);
  assert.equal(containsRawAddress({ actorId: "abc123" }), false);
});

test("the reasoning feed still refuses a wallet as an agent id", async () => {
  const { validateReasoningEvent } = await import("../../lib/reasoning/schema");
  const event = {
    eventId: "1:agent:vote",
    schemaVersion: 1,
    claimId: 1,
    agentId: ACCOUNT_A,
    track: "classic",
    stage: "vote",
    position: "creator",
    confidenceBps: 5000,
    summary: "s",
    uncertainty: "",
    evidenceRefs: [],
    visibility: "public",
    createdAt: 1,
  } as unknown as Parameters<typeof validateReasoningEvent>[0];

  const { ok, errors } = validateReasoningEvent(event);
  assert.equal(ok, false);
  assert.ok(
    errors.some((e) => /registry id/.test(e)),
    `a G… wallet is not a registry id and must be rejected, got: ${errors.join("; ")}`,
  );

  // A contract id is equally not a registry id.
  const contractCase = validateReasoningEvent({ ...event, agentId: CONTRACT_A });
  assert.ok(contractCase.errors.some((e) => /registry id/.test(e)));

  // A genuine registry id must not trip the wallet guard.
  const registryCase = validateReasoningEvent({ ...event, agentId: "council-keynes" });
  assert.ok(!registryCase.errors.some((e) => /registry id/.test(e)));
});
