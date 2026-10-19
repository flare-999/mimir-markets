/**
 * waitForTransaction reports a landed, failed or still-pending transaction
 * from a stubbed RPC server, and never throws on an RPC error.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { rpc } from "@stellar/stellar-sdk";

import { waitForTransaction } from "../../lib/stellar";

function stub(result: unknown): rpc.Server {
  return {
    pollTransaction: async () => {
      if (result instanceof Error) throw result;
      return result;
    },
  } as unknown as rpc.Server;
}

const HASH = "a".repeat(64);

test("a successful transaction is reported as succeeded", async () => {
  const out = await waitForTransaction(HASH, {
    server: stub({ status: rpc.Api.GetTransactionStatus.SUCCESS }),
  });
  assert.equal(out.succeeded, true);
  assert.equal(out.pending, false);
  assert.equal(out.hash, HASH);
});

test("a failed transaction is neither succeeded nor pending", async () => {
  const out = await waitForTransaction(HASH, {
    server: stub({ status: rpc.Api.GetTransactionStatus.FAILED }),
  });
  assert.equal(out.succeeded, false);
  assert.equal(out.pending, false);
});

test("an exhausted poll budget is pending, not failed", async () => {
  const out = await waitForTransaction(HASH, {
    server: stub({ status: rpc.Api.GetTransactionStatus.NOT_FOUND }),
  });
  assert.equal(out.pending, true);
  assert.equal(out.succeeded, false);
});

test("an RPC error is reported as pending instead of thrown", async () => {
  const out = await waitForTransaction(HASH, { server: stub(new Error("boom")) });
  assert.equal(out.pending, true);
  assert.equal(out.response, null);
});
