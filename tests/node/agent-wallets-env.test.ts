import assert from "node:assert/strict";
import test from "node:test";
import { Keypair } from "@stellar/stellar-sdk";

import {
  councilEnvSlug,
  councilPublicEnv,
  councilSecretEnv,
  getCouncilAddress,
  getCouncilWallet,
  getCreatorWallet,
  getOracleWallet,
  loadAgentWallet,
  publicEnvName,
  secretEnvName,
} from "../../lib/agent-wallets";
import {
  listCouncilPersonas,
  personaPublicEnv,
  personaSecretEnv,
} from "../../agents/council/personas";
import {
  PHILOSOPHER_PERSONAS,
  philosopherPublicEnv,
  philosopherSecretEnv,
} from "../../agents/council/philosophers";
import { TRADER_PERSONAS } from "../../agents/traders/personas";

// ── Slug normalisation (hyphens, case) ──────────────────────────────────────

test("councilEnvSlug converts kebab-case to uppercase screaming snake_case", () => {
  assert.equal(councilEnvSlug("crypto-maxi"), "CRYPTO_MAXI");
  assert.equal(councilEnvSlug("lao-tzu"), "LAO_TZU");
  assert.equal(councilEnvSlug("ai-skeptic"), "AI_SKEPTIC");
  assert.equal(councilEnvSlug("fast-and-furious"), "FAST_AND_FURIOUS");
});

test("councilEnvSlug normalises case and preserves existing underscores", () => {
  assert.equal(councilEnvSlug("contrarian"), "CONTRARIAN");
  assert.equal(councilEnvSlug("CONTRARIAN"), "CONTRARIAN");
  assert.equal(councilEnvSlug("Macro-Bear"), "MACRO_BEAR");
  assert.equal(councilEnvSlug("whale_watcher"), "WHALE_WATCHER");
  assert.equal(councilEnvSlug("trader-1"), "TRADER_1");
});

test("councilSecretEnv and councilPublicEnv format consistent variable names", () => {
  assert.equal(councilSecretEnv("crypto-maxi"), "COUNCIL_CRYPTO_MAXI_SECRET");
  assert.equal(councilPublicEnv("crypto-maxi"), "COUNCIL_CRYPTO_MAXI_PUBLIC");
  assert.equal(councilSecretEnv("lao-tzu"), "COUNCIL_LAO_TZU_SECRET");
  assert.equal(councilPublicEnv("lao-tzu"), "COUNCIL_LAO_TZU_PUBLIC");
  assert.equal(councilSecretEnv("SOCRATES"), "COUNCIL_SOCRATES_SECRET");
  assert.equal(councilPublicEnv("SOCRATES"), "COUNCIL_SOCRATES_PUBLIC");
});

// ── Secret and public names per role ────────────────────────────────────────

test("secretEnvName accepts bare role or full var name", () => {
  assert.equal(secretEnvName("oracle"), "ORACLE_SECRET");
  assert.equal(secretEnvName("ORACLE"), "ORACLE_SECRET");
  assert.equal(secretEnvName("ORACLE_SECRET"), "ORACLE_SECRET");
  assert.equal(secretEnvName("oracle_secret"), "ORACLE_SECRET");
  assert.equal(secretEnvName("oracle-secret"), "ORACLE_SECRET");

  assert.equal(secretEnvName("creator"), "CREATOR_SECRET");
  assert.equal(secretEnvName("CREATOR_SECRET"), "CREATOR_SECRET");
  assert.equal(secretEnvName("market-creator"), "MARKET_CREATOR_SECRET");
  assert.equal(secretEnvName("market_creator"), "MARKET_CREATOR_SECRET");
});

test("publicEnvName derives public var name from role, secret var, or public var", () => {
  // From bare role
  assert.equal(publicEnvName("oracle"), "ORACLE_PUBLIC");
  assert.equal(publicEnvName("creator"), "CREATOR_PUBLIC");
  assert.equal(publicEnvName("market-creator"), "MARKET_CREATOR_PUBLIC");

  // From secret var name
  assert.equal(publicEnvName("ORACLE_SECRET"), "ORACLE_PUBLIC");
  assert.equal(publicEnvName("oracle_secret"), "ORACLE_PUBLIC");
  assert.equal(publicEnvName("CREATOR_SECRET"), "CREATOR_PUBLIC");
  assert.equal(publicEnvName("COUNCIL_CRYPTO_MAXI_SECRET"), "COUNCIL_CRYPTO_MAXI_PUBLIC");
  assert.equal(publicEnvName("TRADER_MOMENTUM_SECRET"), "TRADER_MOMENTUM_PUBLIC");

  // From existing public var name (idempotent)
  assert.equal(publicEnvName("ORACLE_PUBLIC"), "ORACLE_PUBLIC");
  assert.equal(publicEnvName("oracle_public"), "ORACLE_PUBLIC");
  assert.equal(publicEnvName("oracle-public"), "ORACLE_PUBLIC");
  assert.equal(publicEnvName("COUNCIL_CRYPTO_MAXI_PUBLIC"), "COUNCIL_CRYPTO_MAXI_PUBLIC");
});

// ── Personas and roles mapping fidelity ─────────────────────────────────────

test("every classic council persona matches councilSecretEnv and councilPublicEnv", () => {
  const personas = listCouncilPersonas();
  assert.ok(personas.length > 0, "must have registered council personas");

  for (const persona of personas) {
    const expectedSecret = councilSecretEnv(persona.slug);
    const expectedPublic = councilPublicEnv(persona.slug);

    // Mappings defined in agents/council/personas.ts must align identically
    assert.equal(personaSecretEnv(persona), expectedSecret);
    assert.equal(personaPublicEnv(persona), expectedPublic);

    // secretEnvName and publicEnvName must round-trip cleanly
    assert.equal(secretEnvName(expectedSecret), expectedSecret);
    assert.equal(publicEnvName(expectedSecret), expectedPublic);
    assert.equal(publicEnvName(expectedPublic), expectedPublic);
  }
});

test("every philosopher persona matches councilSecretEnv and councilPublicEnv", () => {
  assert.ok(PHILOSOPHER_PERSONAS.length > 0, "must have philosopher personas");

  for (const persona of PHILOSOPHER_PERSONAS) {
    const expectedSecret = councilSecretEnv(persona.slug);
    const expectedPublic = councilPublicEnv(persona.slug);

    // Mappings in agents/council/philosophers.ts must align identically
    assert.equal(philosopherSecretEnv(persona.slug), expectedSecret);
    assert.equal(philosopherPublicEnv(persona.slug), expectedPublic);

    assert.equal(secretEnvName(expectedSecret), expectedSecret);
    assert.equal(publicEnvName(expectedSecret), expectedPublic);
    assert.equal(publicEnvName(expectedPublic), expectedPublic);
  }
});

test("every trader persona env names align with helper rules", () => {
  assert.ok(TRADER_PERSONAS.length > 0, "must have trader personas");

  for (const trader of TRADER_PERSONAS) {
    assert.equal(secretEnvName(trader.keyEnv), trader.keyEnv);
    assert.equal(publicEnvName(trader.keyEnv), trader.addressEnv);
    assert.equal(publicEnvName(trader.addressEnv), trader.addressEnv);
  }
});

// ── Offline loadAgentWallet with injected env objects ───────────────────────

test("loadAgentWallet creates wallet offline with injected env object", () => {
  const kp = Keypair.random();
  const env = { ORACLE_SECRET: kp.secret() };

  // By explicit var name
  const walletFromVar = loadAgentWallet("ORACLE_SECRET", env);
  assert.equal(walletFromVar.address, kp.publicKey());
  assert.equal(walletFromVar.keypair.secret(), kp.secret());

  // By bare role name
  const walletFromRole = loadAgentWallet("oracle", env);
  assert.equal(walletFromRole.address, kp.publicKey());
});

test("loadAgentWallet trims whitespace, CRLF, and inline comments offline", () => {
  const kp = Keypair.random();
  const env = {
    CREATOR_SECRET: `  ${kp.secret()}   # creator testnet wallet \r\n`,
  };

  const wallet = loadAgentWallet("CREATOR_SECRET", env);
  assert.equal(wallet.address, kp.publicKey());
  assert.equal(wallet.keypair.secret(), kp.secret());
});

test("loadAgentWallet rejects missing seed and names the variable (never the value)", () => {
  const missingCases = [
    { label: "empty env object", env: {} },
    { label: "undefined value", env: { ORACLE_SECRET: undefined } },
    { label: "empty string", env: { ORACLE_SECRET: "" } },
    { label: "whitespace only", env: { ORACLE_SECRET: "    \r\n" } },
    { label: "comment only", env: { ORACLE_SECRET: "   # comment only" } },
  ];

  for (const { label, env } of missingCases) {
    assert.throws(
      () => loadAgentWallet("ORACLE_SECRET", env),
      (err: unknown) => {
        assert.ok(err instanceof Error, `${label}: must throw Error`);
        assert.match(err.message, /ORACLE_SECRET env var is required/);
        return true;
      },
      `${label} must throw error naming ORACLE_SECRET`,
    );
  }
});

test("loadAgentWallet rejects malformed seed and names the variable (never the value)", () => {
  const malformedSeeds = [
    "not-a-valid-seed",
    "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7", // public key (G...), not secret (S...)
    "S123", // too short
    "s" + "a".repeat(55), // lowercase
    "S" + "8".repeat(55), // non-base32 character '8'
    "S" + "A".repeat(55), // invalid checksum
    "S" + "B".repeat(56), // too long
  ];

  for (const badSeed of malformedSeeds) {
    assert.throws(
      () => loadAgentWallet("COUNCIL_CRYPTO_MAXI_SECRET", { COUNCIL_CRYPTO_MAXI_SECRET: badSeed }),
      (err: unknown) => {
        assert.ok(err instanceof Error, `Bad seed ${badSeed} must throw Error`);
        // Must name the variable
        assert.match(err.message, /COUNCIL_CRYPTO_MAXI_SECRET/);
        // Must NEVER reveal the invalid secret value
        assert.equal(
          err.message.includes(badSeed),
          false,
          `Error message must NEVER include the secret value: "${err.message}"`,
        );
        return true;
      },
      `Malformed seed ${badSeed} must be rejected naming variable, never value`,
    );
  }
});

test("convenience getters load offline from injected env objects", () => {
  const oracleKp = Keypair.random();
  const creatorKp = Keypair.random();
  const councilKp = Keypair.random();

  const env = {
    ORACLE_SECRET: oracleKp.secret(),
    CREATOR_SECRET: creatorKp.secret(),
    COUNCIL_LAO_TZU_SECRET: councilKp.secret(),
    COUNCIL_LAO_TZU_PUBLIC: councilKp.publicKey(),
  };

  const oracleWallet = getOracleWallet(env);
  assert.equal(oracleWallet.address, oracleKp.publicKey());

  const creatorWallet = getCreatorWallet(env);
  assert.equal(creatorWallet.address, creatorKp.publicKey());

  const councilWallet = getCouncilWallet("lao-tzu", env);
  assert.equal(councilWallet.address, councilKp.publicKey());

  // getCouncilAddress reads public key without touching secret
  assert.equal(getCouncilAddress("lao-tzu", env), councilKp.publicKey());
  assert.equal(getCouncilAddress("nonexistent-persona", env), undefined);
});

test("loadAgentWallet names the resolved variable name when called with a bare role", () => {
  assert.throws(
    () => loadAgentWallet("oracle", {}),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /ORACLE_SECRET env var is required/);
      return true;
    },
  );

  assert.throws(
    () => loadAgentWallet("market-creator", { MARKET_CREATOR_SECRET: "not-a-secret" }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /MARKET_CREATOR_SECRET must be a Stellar secret seed/);
      assert.equal(err.message.includes("not-a-secret"), false);
      return true;
    },
  );
});

test("loadAgentWallet falls back to process.env when env parameter is omitted", () => {
  const kp = Keypair.random();
  const testKey = "TEST_ROLE_SECRET";
  const prev = process.env[testKey];
  try {
    process.env[testKey] = kp.secret();
    const wallet = loadAgentWallet(testKey);
    assert.equal(wallet.address, kp.publicKey());
    assert.equal(wallet.keypair.secret(), kp.secret());
  } finally {
    if (prev === undefined) delete process.env[testKey];
    else process.env[testKey] = prev;
  }
});

test("getCouncilAddress ignores malformed or non-account addresses", () => {
  const env = {
    COUNCIL_JUNK_PUBLIC: "not-an-address",
    COUNCIL_SECRET_IN_PUBLIC_ENV_PUBLIC: "SB223456789012345678901234567890123456789012345678901234",
  };
  assert.equal(getCouncilAddress("junk", env), undefined);
  assert.equal(getCouncilAddress("secret-in-public-env", env), undefined);
});

