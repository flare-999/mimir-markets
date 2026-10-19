/**
 * Release readiness checklist — CLI.
 *
 *   npm run verify:release-readiness                          # self-check + offline gates
 *   npm run verify:release-readiness -- --list                # print the checklist
 *   npm run verify:release-readiness -- --evidence ev.json    # evaluate recorded evidence
 *   npm run verify:release-readiness -- --mode=release        # funded-release gate
 *   npm run verify:release-readiness -- --json --out record.json
 *
 * Reproducible from a clean checkout: it reads only tracked repo files, runs
 * the offline verifiers, and never reads `.env`, a database URL, a seed or any
 * other production credential. Gates that need a live deployment are reported
 * as *not evidenced* — never as passing — until a maintainer records evidence
 * with `--evidence`.
 *
 * Exit codes:
 *   0  every check this mode requires passed
 *   1  a check failed, the checklist is incoherent, or (in release mode) a
 *      gate has no evidence
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  RELEASE_GATES,
  buildReleaseRecord,
  evaluateReleaseReadiness,
  findDocumentationDrift,
  formatReleaseReadinessReport,
  parseReleaseEvidence,
  serializeReleaseRecord,
  validateReleaseReadinessRegistry,
  type ReleaseGateEvidence,
  type ReleaseGateId,
  type ReleaseMode,
} from "../lib/ops/release-readiness";
import {
  formatProvenanceReport,
  verifyRepoArtifactProvenance,
} from "../lib/ops/artifact-provenance";
import {
  formatCacheBackupReport,
  verifyCacheBackup,
} from "../lib/ops/cache-backup";
import {
  loadLedgerFixture,
  replayLedgerFixture,
} from "../lib/ops/ledger-fixture";
import {
  buildCycloneDxFromLockfile,
  loadLockfile,
} from "./generate-release-sbom.mjs";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const READINESS_DOC = path.join(REPO_ROOT, "docs", "RELEASE_READINESS.md");

interface Args {
  list: boolean;
  evidence?: string;
  mode: ReleaseMode;
  json: boolean;
  out?: string;
  stamp: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args = new Set(argv);
  const evidenceIndex = argv.findIndex((value) => value === "--evidence");
  const outIndex = argv.findIndex((value) => value === "--out");
  return {
    list: args.has("--list"),
    evidence:
      evidenceIndex >= 0 && argv[evidenceIndex + 1]
        ? argv[evidenceIndex + 1]
        : undefined,
    mode:
      args.has("--mode=release") || args.has("--release")
        ? "release"
        : "develop",
    json: args.has("--json"),
    out: outIndex >= 0 && argv[outIndex + 1] ? argv[outIndex + 1] : undefined,
    stamp: args.has("--stamp"),
    help: args.has("--help") || args.has("-h"),
  };
}

function printChecklist(): void {
  console.log("Mimir release readiness checklist");
  console.log("");
  for (const gate of RELEASE_GATES) {
    const flags = [
      gate.blocking ? "blocking" : "advisory",
      gate.reproducibility === "clean-checkout"
        ? "clean-checkout"
        : "live-evidence",
      `secrets: ${gate.secrets}`,
      `area: ${gate.area}`,
    ].join(" · ");
    console.log(`${gate.id} — ${gate.title}`);
    console.log(`  ${flags}`);
    console.log(`  $ ${gate.command}`);
    console.log(`  failure   : ${gate.failure}`);
    console.log(`  rollback  : ${gate.rollback}`);
    console.log(`  produces  : ${gate.produces}`);
    console.log(
      `  env       : ${gate.env.length > 0 ? gate.env.join(", ") : "(none)"}`,
    );
    console.log(`  protects  : ${gate.protects}`);
    console.log("");
  }
}

// ── The self-check: is this checklist still runnable and documented? ─────────

interface SelfCheck {
  problems: string[];
  notes: string[];
}

function selfCheck(): SelfCheck {
  const problems: string[] = [];
  const notes: string[] = [];

  problems.push(...validateReleaseReadinessRegistry());

  // Every declared npm script must exist, or the doc tells a maintainer to run
  // a command that no longer does anything.
  const pkg = JSON.parse(
    readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
  ) as {
    scripts?: Record<string, string>;
  };
  const scripts = pkg.scripts ?? {};
  for (const gate of RELEASE_GATES) {
    if (gate.npmScript && !(gate.npmScript in scripts)) {
      problems.push(
        `package.json has no script "${gate.npmScript}" required by "${gate.id}"`,
      );
    }
  }

  // Every path a clean checkout needs must be tracked in the repo.
  for (const gate of RELEASE_GATES) {
    for (const relative of gate.checkPaths) {
      if (!existsSync(path.join(REPO_ROOT, relative))) {
        problems.push(
          `gate "${gate.id}" needs "${relative}", which is missing from the checkout`,
        );
      }
    }
  }

  if (!existsSync(READINESS_DOC)) {
    problems.push("docs/RELEASE_READINESS.md is missing");
  } else {
    problems.push(
      ...findDocumentationDrift(readFileSync(READINESS_DOC, "utf8")),
    );
  }

  notes.push(`${RELEASE_GATES.length} gates registered`);
  return { problems, notes };
}

// ── The offline verifiers ────────────────────────────────────────────────────

type OfflineResult = { status: "pass" | "fail"; detail: string };

function checkArtifactProvenance(mode: ReleaseMode): OfflineResult {
  const report = verifyRepoArtifactProvenance({
    repoRoot: REPO_ROOT,
    mode,
    requireBuilt: mode === "release",
  });
  const errors = report.findings.filter(
    (finding) => finding.severity === "error",
  );
  return {
    status: errors.length === 0 ? "pass" : "fail",
    detail:
      errors.length === 0
        ? `manifest verified (${Object.keys(report.digests).length} digest(s) computed)`
        : `${errors.length} provenance error(s): ${errors.map((f) => f.code).join(", ")}`,
  };
}

function checkCacheBackup(): OfflineResult {
  const archive = path.join(
    REPO_ROOT,
    "tests",
    "fixtures",
    "cache-backup",
    "valid.json",
  );
  const report = verifyCacheBackup(readFileSync(archive, "utf8"));
  return {
    status: report.ok ? "pass" : "fail",
    detail: report.ok
      ? `fixture archive verified (checksum ${report.backup?.checksum.slice(0, 16)}…)`
      : `${report.findings.filter((f) => f.severity === "error").length} backup error(s)`,
  };
}

async function checkLedgerFixture(): Promise<OfflineResult> {
  const fixture = await loadLedgerFixture(
    path.join(REPO_ROOT, "fixtures", "ledger", "funded-market-v1.json"),
  );
  const artifact = replayLedgerFixture(fixture);
  return {
    status: "pass",
    detail:
      `replayed ${artifact.reconciliation.eventCount} event(s), ` +
      `${artifact.reconciliation.claimCount} claim(s), fingerprint ${artifact.reconciliation.fingerprint.slice(0, 16)}…`,
  };
}

function checkReleaseSbom(): OfflineResult {
  const lock = loadLockfile(path.join(REPO_ROOT, "package-lock.json"));
  const bom = buildCycloneDxFromLockfile(lock, {
    name: "mimir",
    version: "0.1.0",
  });
  return {
    status: bom.components.length > 0 ? "pass" : "fail",
    detail: `${bom.components.length} component(s) in the CycloneDX ${bom.specVersion} document`,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(
      [
        "Usage: node scripts/verify-release-readiness.ts [options]",
        "",
        "  --list                 print every gate with its failure, rollback and artifact notes",
        "  --evidence <file>      evaluate a recorded evidence JSON file",
        "  --mode=release         funded-release mode: unevidenced gates are errors",
        "  --json                 print the report as JSON instead of text",
        "  --out <file>           write a deterministic release record",
        "  --stamp                add a recordedAt timestamp to the written record",
      ].join("\n"),
    );
    return;
  }

  if (args.list) {
    printChecklist();
    return;
  }

  const { problems, notes } = selfCheck();

  // Evidence recorded by a maintainer for the live-evidence gates.
  let recorded: Record<string, ReleaseGateEvidence> = {};
  if (args.evidence) {
    const evidencePath = path.resolve(process.cwd(), args.evidence);
    if (!existsSync(evidencePath)) {
      console.error(`✗ evidence file not found: ${args.evidence}`);
      process.exit(1);
    }
    try {
      recorded = parseReleaseEvidence(
        JSON.parse(readFileSync(evidencePath, "utf8")),
      ).results;
    } catch (error) {
      console.error(
        `✗ release evidence refused: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    }
  }

  // Offline gates are verified here, now — a stale evidence file can never
  // override a check the tool just ran itself.
  const offline: Record<string, ReleaseGateEvidence> = {
    "release-readiness-checklist": {
      status: problems.length === 0 ? "pass" : "fail",
      detail:
        problems.length === 0
          ? `checklist coherent and documented (${notes.join("; ")})`
          : `${problems.length} problem(s): ${problems.join("; ")}`,
    },
  };

  try {
    offline["artifact-provenance"] = checkArtifactProvenance(args.mode);
    offline["cache-backup-verify"] = checkCacheBackup();
    offline["ledger-fixture-replay"] = await checkLedgerFixture();
    offline["release-sbom"] = checkReleaseSbom();
  } catch (error) {
    console.error(
      `✗ offline verification crashed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }

  const evidence = { ...recorded, ...offline };
  const report = evaluateReleaseReadiness(
    {
      schemaVersion: 1,
      kind: "mimir-release-readiness",
      results: evidence,
    },
    { mode: args.mode },
  );

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    if (offline["artifact-provenance"].status === "pass") {
      console.log(
        formatProvenanceReport(
          verifyRepoArtifactProvenance({
            repoRoot: REPO_ROOT,
            mode: args.mode,
            requireBuilt: args.mode === "release",
          }),
        ),
      );
      console.log(
        formatCacheBackupReport(
          verifyCacheBackup(
            readFileSync(
              path.join(
                REPO_ROOT,
                "tests",
                "fixtures",
                "cache-backup",
                "valid.json",
              ),
              "utf8",
            ),
          ),
        ),
      );
      console.log("");
    }
    console.log(formatReleaseReadinessReport(report));
  }

  if (args.out) {
    const record = buildReleaseRecord(report, {
      recordedAt: args.stamp ? new Date().toISOString() : undefined,
    });
    const outPath = path.resolve(process.cwd(), args.out);
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, serializeReleaseRecord(record), "utf8");
    console.log(
      `  · release record → ${path.relative(REPO_ROOT, outPath) || args.out}`,
    );
  }

  if (!report.ok) process.exit(1);
}

main().catch((error) => {
  console.error(
    "[verify:release-readiness] failed:",
    error instanceof Error ? error.message : error,
  );
  process.exit(1);
});
