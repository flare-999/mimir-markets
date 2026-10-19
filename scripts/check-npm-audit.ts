/**
 * Triage an `npm audit --json` report.
 *
 *   npm run audit:deps -- --json npm-audit.json
 *   npm run audit:deps -- --json npm-audit.json --out npm-audit-report.md
 *   node --import tsx scripts/check-npm-audit.ts tests/fixtures/dependency-audit/clean.json
 *
 * Reproducible from a clean checkout. No production secrets, no registry
 * calls, no deployment credentials — the JSON on disk is the only input.
 *
 * Exit codes:
 *   0  PASS (no high/critical/unknown production advisories)
 *   1  FAIL (blocking findings, malformed report, or npm error)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { formatAuditReport, triageNpmAudit } from "../lib/ops/dependency-audit";

export function parseArgs(argv = process.argv.slice(2)): {
  json: string | null;
  out: string | null;
  help: boolean;
} {
  const out: { json: string | null; out: string | null; help: boolean } = {
    json: null,
    out: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") {
      out.json = argv[++i] ?? null;
    } else if (arg === "--out") {
      out.out = argv[++i] ?? null;
    } else if (arg === "--help" || arg === "-h") {
      out.help = true;
    } else if (!arg.startsWith("-") && out.json === null) {
      out.json = arg;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return out;
}

export function evaluateAuditFile(
  jsonPath: string,
  outPath?: string | null,
): { code: number; markdown: string } {
  let raw: string;
  try {
    raw = readFileSync(jsonPath, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `cannot read audit JSON at ${jsonPath} (${reason}). From a clean checkout run: npm audit --omit=dev --json > npm-audit.json`,
    );
  }

  const report = triageNpmAudit(raw);
  const markdown = formatAuditReport(report);
  if (outPath) {
    writeFileSync(outPath, markdown, "utf8");
  }
  return { code: report.ok ? 0 : 1, markdown };
}

export function main(argv = process.argv.slice(2)): number {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(
      "Usage: node --import tsx scripts/check-npm-audit.ts [--json <audit.json>] [--out <report.md>]",
    );
    return 0;
  }
  if (!args.json) {
    throw new Error(
      "usage: check-npm-audit.ts --json <audit.json> [--out report.md]",
    );
  }

  const { code, markdown } = evaluateAuditFile(args.json, args.out);
  process.stdout.write(markdown);
  return code;
}

const isMain =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
  try {
    process.exit(main());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const markdown = [
      "# Dependency vulnerability triage",
      "",
      "Result: FAIL — audit triage could not run.",
      `Reason: ${message}`,
      "Fail-closed: do not skip this gate or ship on an incomplete scan.",
      "",
    ].join("\n");
    const outFlag = process.argv.indexOf("--out");
    if (outFlag !== -1 && process.argv[outFlag + 1]) {
      try {
        writeFileSync(process.argv[outFlag + 1], `${markdown}\n`, "utf8");
      } catch {
        // Still fail closed even if the artifact cannot be written.
      }
    }
    console.error(`✗ ${message}`);
    process.exit(1);
  }
}
