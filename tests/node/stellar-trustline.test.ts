/**
 * Deterministic unit coverage for `readUsdcTrustline` in `lib/stellar-trustline.ts`.
 *
 * Pins how Horizon `/accounts/{id}` JSON responses and transport errors map onto
 * `TrustlineState` (`ready`, `missing`, `unfunded`, `unknown`) without touching
 * the network.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  readUsdcTrustline,
  type HorizonAccount,
  type HorizonBalanceLine,
  type TrustlineStatus,
} from "../../lib/stellar-trustline";
import { USDC_CODE, USDC_ISSUER } from "../../lib/usdc";
import { evaluateUsdcTrustlineGate, usdcTrustlineGateFixture } from "../../lib/usdcTrustlineGate";

const ACCOUNT_A = "GBO43ZBS4RBC2QFDKB23U6TBFEEK47ZLGSXDJSRV2H3PNQK5ZDEYXVLE";
const IMPOSTOR_ISSUER = "GD2SI5PUEFKC7TONNX7OR72WMYUO7WZDSCDSIVWWXPDIDYW5OP3ETM5D";
const CONTRACT_A = "CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR";
const EVM_ADDRESS = "0x0000000000000000000000000000000000000abc";

const NATIVE_BALANCE_LINE: HorizonBalanceLine = {
  balance: "100.0000000",
  buying_liabilities: "0.0000000",
  selling_liabilities: "0.0000000",
  asset_type: "native",
};

function usdcBalanceLine(overrides: Partial<HorizonBalanceLine> = {}): HorizonBalanceLine {
  return {
    balance: "42.5000000",
    limit: "922337203685.4775807",
    buying_liabilities: "0.0000000",
    selling_liabilities: "0.0000000",
    last_modified_ledger: 512340,
    is_authorized: true,
    is_authorized_to_maintain_liabilities: false,
    is_clawback_enabled: false,
    asset_type: "credit_alphanum4",
    asset_code: USDC_CODE,
    asset_issuer: USDC_ISSUER,
    ...overrides,
  };
}

function horizonAccountFixture(
  balances: readonly HorizonBalanceLine[],
  accountId = ACCOUNT_A,
): HorizonAccount & Record<string, unknown> {
  return JSON.parse(
    JSON.stringify({
      id: accountId,
      account_id: accountId,
      sequence: "4294967296",
      subentry_count: Math.max(0, balances.length - 1),
      thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
      last_modified_ledger: 512340,
      last_modified_time: "2026-10-18T00:00:00Z",
      flags: {
        auth_required: false,
        auth_revocable: false,
        auth_immutable: false,
        auth_clawback_enabled: false,
      },
      balances,
      signers: [{ key: accountId, weight: 1, type: "ed25519_public_key" }],
      data: {},
      num_sponsoring: 0,
      num_sponsored: 0,
    }),
  ) as HorizonAccount & Record<string, unknown>;
}

function horizonError(status: number, message = `Horizon HTTP ${status}`): Error & {
  response: { status: number };
} {
  return Object.assign(new Error(message), { response: { status } });
}

test("authorized USDC trustline fixture is classified as ready with parsed numeric balance", async () => {
  const fixture = horizonAccountFixture([usdcBalanceLine({ balance: "125.7500000" }), NATIVE_BALANCE_LINE]);
  let loadedAddress: string | null = null;

  const state = await readUsdcTrustline(ACCOUNT_A, async (addr) => {
    loadedAddress = addr;
    return fixture;
  });

  assert.equal(loadedAddress, ACCOUNT_A);
  assert.deepEqual(state, { status: "ready", balance: 125.75 });
});

test("zero-balance authorized USDC trustline is ready with 0 balance, not missing", async () => {
  const fixture = horizonAccountFixture([usdcBalanceLine({ balance: "0.0000000" }), NATIVE_BALANCE_LINE]);

  const state = await readUsdcTrustline(ACCOUNT_A, {
    loadAccount: async () => fixture,
  });

  assert.deepEqual(state, { status: "ready", balance: 0 });
});

test("frozen or deauthorized USDC trustlines still classify as ready because trustline exists and contracts park payouts", async () => {
  // Circle's USDC issuer has auth_revocable=true. A frozen trustline remains present
  // in Horizon's balances with is_authorized=false; re-submitting changeTrust cannot
  // unfreeze it, and the Soroban contracts handle frozen recipients via push_or_park.
  const frozenFixture = horizonAccountFixture([
    usdcBalanceLine({
      balance: "18.2500000",
      is_authorized: false,
      is_authorized_to_maintain_liabilities: false,
    }),
    NATIVE_BALANCE_LINE,
  ]);
  const maintainLiabilitiesOnlyFixture = horizonAccountFixture([
    usdcBalanceLine({
      balance: "5.0000000",
      is_authorized: false,
      is_authorized_to_maintain_liabilities: true,
    }),
    NATIVE_BALANCE_LINE,
  ]);

  const frozenState = await readUsdcTrustline(ACCOUNT_A, async () => frozenFixture);
  const maintainState = await readUsdcTrustline(ACCOUNT_A, async () => maintainLiabilitiesOnlyFixture);

  assert.deepEqual(frozenState, { status: "ready", balance: 18.25 });
  assert.deepEqual(maintainState, { status: "ready", balance: 5 });

  // Gate allows payout/withdraw actions to proceed so the contract can park or settle.
  const payoutGate = evaluateUsdcTrustlineGate(
    usdcTrustlineGateFixture({ action: "payout", status: frozenState.status }),
  );
  assert.equal(payoutGate.allowed, true);
  assert.equal(payoutGate.status, "ready");
});

test("trustlines with custom or exhausted limits still classify as present and report current balance", async () => {
  const cappedAtLimitFixture = horizonAccountFixture([
    usdcBalanceLine({
      balance: "10.0000000",
      limit: "10.0000000",
    }),
    NATIVE_BALANCE_LINE,
  ]);
  const zeroLimitFixture = horizonAccountFixture([
    usdcBalanceLine({
      balance: "0.0000000",
      limit: "0.0000000",
    }),
    NATIVE_BALANCE_LINE,
  ]);

  const cappedState = await readUsdcTrustline(ACCOUNT_A, {
    server: { loadAccount: async () => cappedAtLimitFixture },
  });
  const zeroLimitState = await readUsdcTrustline(ACCOUNT_A, {
    server: { loadAccount: async () => zeroLimitFixture },
  });

  assert.deepEqual(cappedState, { status: "ready", balance: 10 });
  assert.deepEqual(zeroLimitState, { status: "ready", balance: 0 });
});

test("funded account without a matching USDC trustline is classified as missing", async () => {
  const nativeOnlyFixture = horizonAccountFixture([NATIVE_BALANCE_LINE]);
  const wrongIssuerFixture = horizonAccountFixture([
    usdcBalanceLine({ asset_issuer: IMPOSTOR_ISSUER, balance: "999.0000000" }),
    NATIVE_BALANCE_LINE,
  ]);
  const wrongCodeFixture = horizonAccountFixture([
    usdcBalanceLine({ asset_code: "EURC", balance: "50.0000000" }),
    NATIVE_BALANCE_LINE,
  ]);
  const liquidityPoolOnlyFixture = horizonAccountFixture([
    {
      asset_type: "liquidity_pool_shares",
      liquidity_pool_id: "dd7b1ab831c273310ddbec6f97870aa83c2fbd78ce22aded37ecbf4f3380fac7",
      balance: "10.0000000",
      limit: "922337203685.4775807",
      is_authorized: true,
      is_authorized_to_maintain_liabilities: false,
      is_clawback_enabled: false,
    },
    NATIVE_BALANCE_LINE,
  ]);

  for (const fixture of [
    nativeOnlyFixture,
    wrongIssuerFixture,
    wrongCodeFixture,
    liquidityPoolOnlyFixture,
  ]) {
    const state = await readUsdcTrustline(ACCOUNT_A, async () => fixture);
    assert.deepEqual(state, { status: "missing", balance: null });
  }
});

test("missing account (Horizon 404) is classified as unfunded", async () => {
  const state = await readUsdcTrustline(ACCOUNT_A, async () => {
    throw horizonError(404, "Not Found");
  });

  assert.deepEqual(state, { status: "unfunded", balance: null });
});

test("non-404 Horizon failures and invalid addresses are classified as unknown", async () => {
  const http503 = await readUsdcTrustline(ACCOUNT_A, async () => {
    throw horizonError(503, "Service Unavailable");
  });
  const networkError = await readUsdcTrustline(ACCOUNT_A, async () => {
    throw new Error("ECONNRESET");
  });

  assert.deepEqual(http503, { status: "unknown", balance: null });
  assert.deepEqual(networkError, { status: "unknown", balance: null });

  let loaderCalled = false;
  for (const invalidAddress of ["", "   ", EVM_ADDRESS, CONTRACT_A, ACCOUNT_A.toLowerCase()]) {
    const state = await readUsdcTrustline(invalidAddress, async () => {
      loaderCalled = true;
      return horizonAccountFixture([usdcBalanceLine(), NATIVE_BALANCE_LINE]);
    });
    assert.deepEqual(state, { status: "unknown", balance: null });
  }
  assert.equal(loaderCalled, false, "Horizon loader must not be called for invalid account addresses");
});

test("every TrustlineStatus value is produced by at least one fixture", async () => {
  const expectedByStatus: Record<TrustlineStatus, () => Promise<TrustlineStatus>> = {
    ready: async () =>
      (
        await readUsdcTrustline(ACCOUNT_A, async () =>
          horizonAccountFixture([usdcBalanceLine(), NATIVE_BALANCE_LINE]),
        )
      ).status,
    missing: async () =>
      (
        await readUsdcTrustline(ACCOUNT_A, async () =>
          horizonAccountFixture([NATIVE_BALANCE_LINE]),
        )
      ).status,
    unfunded: async () =>
      (
        await readUsdcTrustline(ACCOUNT_A, async () => {
          throw horizonError(404);
        })
      ).status,
    unknown: async () =>
      (
        await readUsdcTrustline(ACCOUNT_A, async () => {
          throw horizonError(502);
        })
      ).status,
  };

  const produced = new Set<TrustlineStatus>();
  for (const [expected, runFixture] of Object.entries(expectedByStatus) as Array<
    [TrustlineStatus, () => Promise<TrustlineStatus>]
  >) {
    const actual = await runFixture();
    assert.equal(actual, expected);
    produced.add(actual);
  }

  assert.deepEqual(
    [...produced].sort(),
    ["missing", "ready", "unfunded", "unknown"],
  );
});
