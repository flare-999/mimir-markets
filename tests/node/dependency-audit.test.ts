import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  formatAuditReport,
  redactPrivacy,
  triageNpmAudit,
} from "../../lib/ops/dependency-audit";
import { evaluateAuditFile, parseArgs } from "../../scripts/check-npm-audit";

const FIXTURES = join(process.cwd(), "tests", "fixtures", "dependency-audit");

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8");
}

function fixtureReport(name: string) {
  return triageNpmAudit(fixture(name));
}

// ── positive ────────────────────────────────────────────────────────────────

test("positive: clean production audit passes from the committed fixture", () => {
  const report = fixtureReport("clean.json");
  assert.equal(report.ok, true, formatAuditReport(report));
  assert.equal(report.totals.packages, 0);
  assert.equal(report.totals.blocking, 0);
  assert.equal(report.findings.length, 0);
  assert.match(formatAuditReport(report), /Result: PASS/);
});

test("positive: low and moderate advisories do not block (audit-level=high)", () => {
  const report = fixtureReport("low-moderate.json");
  assert.equal(report.ok, true, formatAuditReport(report));
  assert.equal(report.totals.packages, 2);
  assert.equal(report.blocking.length, 0);
  const markdown = formatAuditReport(report);
  assert.match(markdown, /picomatch/);
  assert.match(markdown, /moderate/);
  assert.match(markdown, /Result: PASS/);
  assert.doesNotMatch(markdown, /\/home\/runner/);
});

// ── negative ────────────────────────────────────────────────────────────────

test("negative: high and critical production advisories fail closed", () => {
  const report = fixtureReport("high-critical.json");
  assert.equal(report.ok, false);
  assert.equal(report.totals.blocking, 2);
  assert.deepEqual(
    report.blocking.map((entry) => entry.packageName),
    ["undici", "next"],
  );
  assert.equal(report.blocking[0].severity, "critical");
  assert.equal(report.blocking[1].severity, "high");
  assert.equal(report.blocking[1].isDirect, true);
  assert.equal(report.blocking[1].fixAvailable, "yes");
  const markdown = formatAuditReport(report);
  assert.match(markdown, /Result: FAIL/);
  assert.match(markdown, /AUDIT_BLOCKING_ADVISORY/);
  assert.match(markdown, /GHSA-zzzz-yyyy-xxxx/);
  assert.doesNotMatch(markdown, /\/home\/runner/);
});

test("negative: unknown severity is treated as blocking", () => {
  const report = fixtureReport("unknown-severity.json");
  assert.equal(report.ok, false);
  assert.equal(report.blocking.length, 1);
  assert.equal(report.blocking[0].severity, "unknown");
  assert.match(formatAuditReport(report), /AUDIT_UNKNOWN_SEVERITY/);
});

// ── failure ─────────────────────────────────────────────────────────────────

test("failure: malformed audit JSON is actionable and does not pass", () => {
  const report = fixtureReport("malformed.json");
  assert.equal(report.ok, false);
  assert.equal(report.findings[0]?.code, "AUDIT_INVALID_JSON");
  assert.match(formatAuditReport(report), /Result: FAIL/);
  assert.doesNotMatch(formatAuditReport(report), /this is not json/);
});

test("failure: empty audit output fails closed", () => {
  const report = triageNpmAudit("");
  assert.equal(report.ok, false);
  assert.equal(report.findings[0]?.code, "AUDIT_INVALID_JSON");
});

test("failure: missing vulnerabilities object fails closed", () => {
  const report = fixtureReport("missing-vulnerabilities.json");
  assert.equal(report.ok, false);
  assert.equal(report.findings[0]?.code, "AUDIT_MISSING_VULNERABILITIES");
});

test("failure: npm error objects fail closed instead of looking clean", () => {
  const report = fixtureReport("npm-error.json");
  assert.equal(report.ok, false);
  assert.equal(report.findings[0]?.code, "AUDIT_NPM_ERROR");
  assert.match(formatAuditReport(report), /ENOAUDIT|does not support audit/);
});

test("failure: unsupported audit report version fails closed", () => {
  const report = fixtureReport("unsupported-version.json");
  assert.equal(report.ok, false);
  assert.equal(report.findings[0]?.code, "AUDIT_UNSUPPORTED_VERSION");
});

test("failure: metadata that claims high/critical with an empty body fails closed", () => {
  const report = fixtureReport("inconsistent-metadata.json");
  assert.equal(report.ok, false);
  assert.equal(report.findings[0]?.code, "AUDIT_INCONSISTENT_METADATA");
});

test("failure: missing audit file is actionable via the CLI", () => {
  assert.throws(
    () => evaluateAuditFile(join(FIXTURES, "does-not-exist.json")),
    /cannot read audit JSON/,
  );
});

// ── regression ──────────────────────────────────────────────────────────────

test("regression: credentialed advisory URLs and tokens are redacted", () => {
  const report = fixtureReport("secret-in-url.json");
  assert.equal(report.ok, false);
  const markdown = formatAuditReport(report);
  assert.doesNotMatch(markdown, /s3cret/);
  assert.doesNotMatch(markdown, /super-secret-token/);
  assert.doesNotMatch(markdown, /\/home\/user/);
  assert.match(markdown, /\*\*\*/);
  assert.match(markdown, /GHSA-pppp-qqqq-rrrr/);
});

test("regression: redactPrivacy leaves public GHSA URLs intact", () => {
  const url = "https://github.com/advisories/GHSA-aaaa-bbbb-cccc";
  assert.equal(redactPrivacy(url), url);
});

test("regression: missing fixAvailable is unknown, not silently yes", () => {
  const report = triageNpmAudit({
    auditReportVersion: 2,
    vulnerabilities: {
      ws: { severity: "high", isDirect: false },
    },
  });
  assert.equal(report.ok, false);
  assert.equal(report.entries[0]?.fixAvailable, "unknown");
});

test("regression: array vulnerabilities and non-objects fail closed", () => {
  assert.equal(triageNpmAudit({ vulnerabilities: [] }).ok, false);
  assert.equal(triageNpmAudit(null).ok, false);
  assert.equal(triageNpmAudit([{ severity: "high" }]).ok, false);
});

test("regression: sorting is by severity rank, not localeCompare", () => {
  const report = triageNpmAudit({
    auditReportVersion: 2,
    vulnerabilities: {
      zebra: { severity: "high" },
      alpha: { severity: "critical" },
      middle: { severity: "moderate" },
    },
  });
  assert.deepEqual(
    report.entries.map((entry) => entry.packageName),
    ["alpha", "zebra", "middle"],
  );
});

test("cli: writes a markdown artifact and exits 0 on the clean fixture", () => {
  const dir = mkdtempSync(join(tmpdir(), "mimir-audit-"));
  try {
    const out = join(dir, "report.md");
    const result = evaluateAuditFile(join(FIXTURES, "clean.json"), out);
    assert.equal(result.code, 0);
    assert.match(result.markdown, /Result: PASS/);
    assert.match(readFileSync(out, "utf8"), /Result: PASS/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cli: blocking fixture exits 1 and still writes the report", () => {
  const dir = mkdtempSync(join(tmpdir(), "mimir-audit-"));
  try {
    const out = join(dir, "report.md");
    const result = evaluateAuditFile(join(FIXTURES, "high-critical.json"), out);
    assert.equal(result.code, 1);
    assert.match(readFileSync(out, "utf8"), /Result: FAIL/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseArgs: rejects unknown flags", () => {
  assert.throws(() => parseArgs(["--nope"]), /Unknown argument/);
});

test("regression: workflow is secret-free and fail-closed", () => {
  const workflow = readFileSync(
    join(process.cwd(), ".github", "workflows", "dependency-audit.yml"),
    "utf8",
  );
  const ci = readFileSync(
    join(process.cwd(), ".github", "workflows", "ci.yml"),
    "utf8",
  );
  for (const source of [workflow, ci]) {
    assert.match(source, /persist-credentials:\s*false/);
    assert.match(source, /npm audit --omit=dev --json/);
    assert.match(source, /check-npm-audit/);
    assert.match(source, /if: always\(\)/);
    assert.doesNotMatch(source, /\$\{\{\s*secrets\./);
    assert.doesNotMatch(source, /SKIP_AUDIT|AUDIT_ALLOW/);
  }
  assert.match(workflow, /workflow_dispatch/);
  assert.match(workflow, /contents:\s*read/);
});
