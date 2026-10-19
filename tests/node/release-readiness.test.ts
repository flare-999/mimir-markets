import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  RELEASE_GATES,
  RELEASE_GATE_IDS,
  buildReleaseRecord,
  cleanCheckoutGates,
  evaluateReleaseEvidence,
  evaluateReleaseReadiness,
  findDocumentationDrift,
  findSecretShapedEvidence,
  formatReleaseReadinessReport,
  getReleaseGate,
  isReleaseGateId,
  liveEvidenceGates,
  looksLikeSecret,
  parseReleaseEvidence,
  releaseReadinessFingerprint,
  serializeReleaseRecord,
  validateReleaseReadinessRegistry,
  type ReleaseEvidence,
} from "../../lib/ops/release-readiness";

const FIXTURES = join(process.cwd(), "tests", "fixtures", "release-readiness");

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as unknown;
}

// ── Registry shape ───────────────────────────────────────────────────────────

test("positive: the registry is internally consistent", () => {
  assert.deepEqual(validateReleaseReadinessRegistry(), []);
  assert.ok(
    RELEASE_GATES.length >= 15,
    "expected a real checklist, not a stub",
  );
  assert.equal(new Set(RELEASE_GATE_IDS).size, RELEASE_GATE_IDS.length);
  assert.ok(cleanCheckoutGates().length > 0);
  assert.ok(liveEvidenceGates().length > 0);
});

test("positive: clean-checkout gates need no secrets and read no env", () => {
  for (const gate of cleanCheckoutGates()) {
    assert.equal(gate.secrets, "none", `${gate.id} must not need secrets`);
    assert.deepEqual(gate.env, [], `${gate.id} must not read env vars`);
    assert.equal(gate.reproducibility, "clean-checkout");
  }
});

test("positive: every gate describes failure, rollback, artifacts, secrets and environment", () => {
  for (const gate of RELEASE_GATES) {
    for (const field of [
      "failure",
      "rollback",
      "produces",
      "environment",
      "protects",
    ] as const) {
      assert.ok(
        gate[field].trim().length >= 20,
        `${gate.id}.${field} must be described explicitly`,
      );
    }
    assert.ok(gate.command.trim().length > 0, `${gate.id} needs a command`);
    for (const relative of gate.checkPaths) {
      assert.ok(
        !relative.startsWith("/") && !relative.includes(".."),
        `${gate.id}: checkPaths must be repo-relative`,
      );
    }
  }
});

test("positive: getReleaseGate resolves and fails closed on unknown ids", () => {
  assert.equal(getReleaseGate("artifact-provenance").area, "artifacts");
  assert.equal(isReleaseGateId("artifact-provenance"), true);
  assert.equal(isReleaseGateId("soroban-audit"), false);
  assert.throws(() => getReleaseGate("soroban-audit"), /unknown release gate/);
});

test("regression: the checklist fingerprint is pinned", () => {
  const fingerprint = releaseReadinessFingerprint();
  assert.match(fingerprint, /^[0-9a-f]{64}$/);
  // Pinned so a gate added, removed or re-scoped lands in the same PR.
  assert.equal(fingerprint, releaseReadinessFingerprint());
  assert.equal(
    fingerprint,
    "5bb50d7ce3e0857b8bf4e091251b6a471fd6603a9ebb27aef2ab4330092442fe",
  );
});

test("regression: the gate id list is pinned", () => {
  assert.deepEqual(
    [...RELEASE_GATE_IDS],
    [
      "typecheck",
      "forbidden-terms",
      "contract-tests",
      "contract-build",
      "node-tests",
      "app-build",
      "browser-smoke",
      "artifact-provenance",
      "release-sbom",
      "cache-backup-verify",
      "ledger-fixture-replay",
      "release-readiness-checklist",
      "deployment-verification",
      "onchain-smoke",
      "x402-payment-smoke",
      "analytics-gates",
      "contract-audit",
      "legal-eligibility-review",
      "redundant-providers",
      "funded-feature-flags",
      "rollback-rehearsal",
      "load-baseline",
    ],
  );
});

// ── Evaluation ───────────────────────────────────────────────────────────────

test("positive: a fully evidenced release is ready", () => {
  const evidence = parseReleaseEvidence(loadFixture("ready.json"));
  const report = evaluateReleaseReadiness(evidence, { mode: "release" });

  assert.equal(report.ok, true, formatReleaseReadinessReport(report));
  assert.equal(report.releaseReady, true);
  assert.equal(report.summary.total, RELEASE_GATES.length);
  assert.equal(report.summary.passed, RELEASE_GATES.length);
  assert.equal(report.summary.failed, 0);
  assert.equal(report.summary.missing, 0);
  assert.deepEqual(report.findings, []);
});

test("positive: offline-only evidence passes in develop mode but is not release ready", () => {
  const evidence = parseReleaseEvidence(loadFixture("offline-only.json"));
  const report = evaluateReleaseReadiness(evidence, { mode: "develop" });

  assert.equal(report.ok, true, formatReleaseReadinessReport(report));
  assert.equal(report.releaseReady, false);
  assert.equal(report.summary.passed, cleanCheckoutGates().length);
  assert.equal(report.summary.missing, liveEvidenceGates().length);
  assert.ok(report.summary.blockingMissing > 0);
  // Warnings only — never an error that would block a clean-checkout run.
  assert.ok(report.findings.every((f) => f.severity === "warning"));
  assert.ok(report.findings.some((f) => f.code === "GATE_NOT_EVIDENCED"));
});

test("negative: release mode refuses unevidenced blocking gates", () => {
  const evidence = parseReleaseEvidence(loadFixture("offline-only.json"));
  const report = evaluateReleaseReadiness(evidence, { mode: "release" });

  assert.equal(report.ok, false);
  assert.equal(report.releaseReady, false);
  assert.ok(
    report.findings.some(
      (f) => f.code === "GATE_MISSING_EVIDENCE" && f.severity === "error",
    ),
  );
  assert.ok(
    report.findings.some((f) => f.gateId === "deployment-verification"),
  );
});

test("failure: a failed gate fails closed and prints its rollback", () => {
  const report = evaluateReleaseEvidence(loadFixture("failed-gate.json"), {
    mode: "release",
  });

  assert.equal(report.ok, false);
  assert.equal(report.releaseReady, false);
  const finding = report.findings.find(
    (f) => f.gateId === "deployment-verification",
  );
  assert.ok(finding, "expected a finding for deployment-verification");
  assert.equal(finding?.code, "GATE_FAILED");
  assert.equal(finding?.severity, "error");
  assert.match(finding?.message ?? "", /Rollback: /);
  const gate = report.gates.find((g) => g.id === "deployment-verification");
  assert.equal(gate?.status, "fail");
  assert.equal(
    gate?.artifact,
    "verify-deployment log retained with the release record",
  );
});

test("failure: secret-shaped evidence is refused, not redacted", () => {
  const evidence = parseReleaseEvidence(loadFixture("secret-shaped.json"));
  const hits = findSecretShapedEvidence(evidence);
  assert.deepEqual(hits, [
    {
      gateId: "deployment-verification",
      field: "detail",
      shape: "url-with-embedded-credentials",
    },
  ]);

  const report = evaluateReleaseReadiness(evidence, { mode: "develop" });
  assert.equal(report.ok, false);
  const finding = report.findings.find(
    (f) => f.code === "EVIDENCE_SECRET_SHAPED",
  );
  assert.ok(finding, "expected an EVIDENCE_SECRET_SHAPED finding");
  assert.equal(finding?.severity, "error");
  assert.match(finding?.message ?? "", /url-with-embedded-credentials/);
});

test("failure: no evidence at all is reported as missing, never as passing", () => {
  const report = evaluateReleaseReadiness(null, { mode: "release" });
  assert.equal(report.ok, false);
  assert.equal(report.releaseReady, false);
  assert.equal(report.summary.missing, RELEASE_GATES.length);
  assert.equal(report.summary.passed, 0);
});

test("failure: malformed evidence JSON fails closed with an actionable reason", () => {
  const report = evaluateReleaseEvidence("{ not json", { mode: "release" });
  assert.equal(report.ok, false);
  assert.equal(report.findings[0]?.code, "EVIDENCE_INVALID");
  assert.equal(report.summary.missing, RELEASE_GATES.length);
});

// ── Evidence parsing (the no-silent-bypass boundary) ─────────────────────────

test("negative: an unknown gate id is refused", () => {
  assert.throws(
    () => parseReleaseEvidence(loadFixture("unknown-gate.json")),
    /unknown release gate/,
  );
});

test("negative: a status other than pass/fail is refused", () => {
  for (const status of [
    "waived",
    "skipped",
    "n/a",
    "pending",
    "PASS",
    true,
    null,
  ]) {
    assert.throws(
      () =>
        parseReleaseEvidence({
          schemaVersion: 1,
          kind: "mimir-release-readiness",
          results: { typecheck: { status } },
        }),
      /must be "pass" or "fail"/,
      `status ${JSON.stringify(status)} must be refused`,
    );
  }
});

test("negative: a recorded waiver is refused", () => {
  // The committed fixture marks a blocking deployment gate as waived, which is
  // exactly the silent bypass the parser exists to stop.
  assert.throws(
    () => parseReleaseEvidence(loadFixture("waived-gate.json")),
    /cannot waive, skip or bypass a gate/,
  );
  assert.throws(
    () =>
      parseReleaseEvidence({
        schemaVersion: 1,
        kind: "mimir-release-readiness",
        results: { typecheck: { status: "pass", waived: true } },
      }),
    /cannot waive, skip or bypass a gate/,
  );
  assert.throws(
    () =>
      parseReleaseEvidence({
        schemaVersion: 1,
        kind: "mimir-release-readiness",
        results: {
          typecheck: { status: "pass", skipped: "no rust toolchain" },
        },
      }),
    /cannot waive, skip or bypass a gate/,
  );
});

test("negative: an unexpected per-gate key is refused", () => {
  assert.throws(
    () =>
      parseReleaseEvidence({
        schemaVersion: 1,
        kind: "mimir-release-readiness",
        results: { typecheck: { status: "pass", waived: true } },
      }),
    /cannot waive, skip or bypass a gate/,
  );
});

test("negative: an empty evidence record cannot stand in for a release", () => {
  assert.throws(
    () => parseReleaseEvidence(loadFixture("empty-results.json")),
    /results is empty/,
  );
});

test("negative: wrong kind or schemaVersion is refused", () => {
  assert.throws(
    () =>
      parseReleaseEvidence({
        schemaVersion: 1,
        kind: "something-else",
        results: { typecheck: { status: "pass" } },
      }),
    /kind must be/,
  );
  assert.throws(
    () =>
      parseReleaseEvidence({
        schemaVersion: 2,
        kind: "mimir-release-readiness",
        results: { typecheck: { status: "pass" } },
      }),
    /schemaVersion must be 1/,
  );
  assert.throws(() => parseReleaseEvidence("nope"), /must be a JSON object/);
  assert.throws(
    () =>
      parseReleaseEvidence({
        schemaVersion: 1,
        kind: "mimir-release-readiness",
        results: [],
      }),
    /results must be an object/,
  );
  assert.throws(
    () =>
      parseReleaseEvidence({
        schemaVersion: 1,
        kind: "mimir-release-readiness",
        results: { typecheck: { status: "pass", detail: "" } },
      }),
    /detail must be a non-empty string/,
  );
});

test("positive: parseReleaseEvidence normalizes and preserves detail/artifact", () => {
  const evidence = parseReleaseEvidence({
    schemaVersion: 1,
    kind: "mimir-release-readiness",
    results: {
      typecheck: { status: "pass", detail: "clean", artifact: "ci run 1234" },
    },
  });
  assert.equal(evidence.results.typecheck.status, "pass");
  assert.equal(evidence.results.typecheck.detail, "clean");
  assert.equal(evidence.results.typecheck.artifact, "ci run 1234");
});

// ── Privacy ──────────────────────────────────────────────────────────────────

test("regression: secret shapes are labelled and clean values pass", () => {
  // Built at runtime so this test file never holds a literal credential.
  const seed = `S${"A".repeat(55)}`;
  assert.equal(looksLikeSecret(seed), "stellar-secret-seed");
  assert.equal(looksLikeSecret("sk-ant-api03-" + "x".repeat(30)), "api-key");
  assert.equal(looksLikeSecret("ghp_" + "x".repeat(36)), "github-token");
  assert.equal(looksLikeSecret("phc_" + "x".repeat(43)), "posthog-key");
  assert.equal(looksLikeSecret("AKIA" + "X".repeat(16)), "aws-access-key");
  assert.equal(looksLikeSecret("-----BEGIN PRIVATE KEY-----"), "private-key");
  assert.equal(
    looksLikeSecret("postgres://mimir:hunter2@db.example.com/mimir"),
    "url-with-embedded-credentials",
  );

  // Public, non-secret values a release record legitimately carries.
  assert.equal(
    looksLikeSecret("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"),
    null,
  );
  assert.equal(
    looksLikeSecret("CAQPTFHY5VXSWR3CNRGFVLGDNEH4NCOE2PCZL4QZ4JQMWVD54GRCMQPX"),
    null,
  );
  assert.equal(
    looksLikeSecret(
      "9dc34491ea02f30e3e2e934aef4e994ca29fad49f7b041f8aaf20bdbff06c72a",
    ),
    null,
  );
  assert.equal(
    looksLikeSecret("https://stellar.expert/explorer/testnet/tx/abc123"),
    null,
  );
  assert.equal(looksLikeSecret("pkg:npm/next@16.2.1"), null);
});

// ── Formatting and the release record ────────────────────────────────────────

test("positive: the report prints every gate, command and finding", () => {
  const report = evaluateReleaseReadiness(
    parseReleaseEvidence(loadFixture("offline-only.json")),
    {
      mode: "develop",
    },
  );
  const text = formatReleaseReadinessReport(report);

  for (const gate of RELEASE_GATES) {
    assert.ok(text.includes(`[${gate.id}]`), `report must list ${gate.id}`);
    assert.ok(
      text.includes(gate.command),
      `report must print the command for ${gate.id}`,
    );
  }
  assert.ok(text.includes("release NOT ready"));
  assert.ok(text.includes("GATE_NOT_EVIDENCED"));
});

test("regression: the release record is deterministic and carries no evidence text", () => {
  const report = evaluateReleaseReadiness(
    parseReleaseEvidence(loadFixture("ready.json")),
    {
      mode: "release",
    },
  );
  const first = serializeReleaseRecord(buildReleaseRecord(report));
  const second = serializeReleaseRecord(buildReleaseRecord(report));
  assert.equal(first, second);

  const record = JSON.parse(first) as {
    kind: string;
    ok: boolean;
    releaseReady: boolean;
    gates: Array<{ id: string; status: string }>;
    recordedAt?: string;
  };
  assert.equal(record.kind, "mimir-release-readiness-record");
  assert.equal(record.ok, true);
  assert.equal(record.releaseReady, true);
  assert.equal(record.gates.length, RELEASE_GATES.length);
  assert.equal(record.recordedAt, undefined);
  // No free-text evidence is copied into a published record.
  assert.equal(JSON.stringify(record).includes("tsc --noEmit clean"), false);

  const stamped = buildReleaseRecord(report, {
    recordedAt: "2026-09-25T00:00:00.000Z",
  });
  assert.equal(stamped.recordedAt, "2026-09-25T00:00:00.000Z");
});

// ── Repo wiring (the checklist cannot drift from what it documents) ──────────

test("regression: docs/RELEASE_READINESS.md documents every gate and command", () => {
  const doc = readFileSync(
    join(process.cwd(), "docs", "RELEASE_READINESS.md"),
    "utf8",
  );
  assert.deepEqual(findDocumentationDrift(doc), []);
});

test("regression: an empty or stale doc is reported as drift", () => {
  assert.deepEqual(findDocumentationDrift(""), [
    "docs/RELEASE_READINESS.md is empty",
  ]);
  const problems = findDocumentationDrift(
    "# Release readiness\n\nOnly some gates are here.\n",
  );
  assert.ok(problems.length >= RELEASE_GATES.length);
  assert.ok(
    problems.some((p) => p.includes('does not mention gate "typecheck"')),
  );
  assert.ok(problems.some((p) => p.includes("does not document the command")));
});

test("regression: every declared npm script exists and every path is checked in", () => {
  const pkg = JSON.parse(
    readFileSync(join(process.cwd(), "package.json"), "utf8"),
  ) as {
    scripts: Record<string, string>;
  };
  assert.ok(
    pkg.scripts["verify:release-readiness"],
    "package.json must expose the check",
  );
  for (const gate of RELEASE_GATES) {
    if (gate.npmScript) {
      assert.ok(
        pkg.scripts[gate.npmScript],
        `package.json has no script "${gate.npmScript}" required by "${gate.id}"`,
      );
    }
    for (const relative of gate.checkPaths) {
      assert.ok(
        existsSync(join(process.cwd(), relative)),
        `gate "${gate.id}" needs "${relative}" in the checkout`,
      );
    }
  }
});

test("regression: the well-formed evidence fixtures stay in sync with the registry", () => {
  // unknown-gate.json and waived-gate.json are deliberately invalid fixtures.
  for (const name of [
    "ready.json",
    "failed-gate.json",
    "secret-shaped.json",
    "offline-only.json",
  ]) {
    const raw = JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as {
      results: Record<string, unknown>;
    };
    for (const id of Object.keys(raw.results)) {
      assert.ok(isReleaseGateId(id), `${name} references unknown gate "${id}"`);
    }
  }
  const ready = parseReleaseEvidence(loadFixture("ready.json"));
  for (const id of RELEASE_GATE_IDS) {
    assert.ok(ready.results[id], `ready.json must evidence "${id}"`);
  }
});

test("regression: CI runs the release readiness check", () => {
  const ci = readFileSync(
    join(process.cwd(), ".github", "workflows", "ci.yml"),
    "utf8",
  );
  assert.ok(
    ci.includes("npm run verify:release-readiness"),
    "ci.yml must gate pull requests on the release readiness checklist",
  );
});

test("regression: the checklist stays offline — no gate reads env it should not", () => {
  const evidence: ReleaseEvidence = {
    schemaVersion: 1,
    kind: "mimir-release-readiness",
    results: Object.fromEntries(
      RELEASE_GATE_IDS.map((id) => [id, { status: "pass" as const }]),
    ),
  };
  const report = evaluateReleaseReadiness(evidence, { mode: "release" });
  assert.equal(report.ok, true);
  assert.equal(report.summary.passed, RELEASE_GATES.length);
});
