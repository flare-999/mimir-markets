/**
 * Dependency-vulnerability triage — fail-closed npm audit reporting.
 *
 * Funded features must not ship with untriaged high/critical production
 * advisories. This module reads `npm audit --json` output and produces a
 * deterministic, privacy-safe report. It never reads env, never talks to the
 * registry, and never inspects wallet seeds or deployment credentials, so the
 * check is reproducible from a clean checkout against committed fixtures.
 *
 * Properties, each pinned by tests:
 *
 *   fail-closed    malformed JSON, npm error objects, missing `vulnerabilities`,
 *                  unsupported report versions, unknown severities, and
 *                  metadata/body disagreement all fail instead of passing
 *   production     callers audit with `--omit=dev`; this checker does not
 *                  second-guess that scope
 *   privacy-safe   reports never echo filesystem `nodes`, credentialed URLs,
 *                  or token-shaped query strings
 *   actionable     every blocking finding names the package, severity, and
 *                  whether a fix is recorded
 */

export const BLOCKING_SEVERITIES = ["high", "critical"] as const;
export const KNOWN_SEVERITIES = [
  "critical",
  "high",
  "moderate",
  "low",
  "info",
] as const;

export type KnownSeverity = (typeof KNOWN_SEVERITIES)[number];
export type AuditSeverity = KnownSeverity | "unknown";

export type AuditFindingCode =
  | "AUDIT_INVALID_JSON"
  | "AUDIT_NOT_OBJECT"
  | "AUDIT_NPM_ERROR"
  | "AUDIT_UNSUPPORTED_VERSION"
  | "AUDIT_MISSING_VULNERABILITIES"
  | "AUDIT_INCONSISTENT_METADATA"
  | "AUDIT_BLOCKING_ADVISORY"
  | "AUDIT_UNKNOWN_SEVERITY";

export interface AuditFinding {
  code: AuditFindingCode;
  severity: "error";
  packageName?: string;
  message: string;
}

export interface AuditAdvisoryRef {
  id: string;
  title: string;
  url: string;
}

export interface AuditPackageEntry {
  packageName: string;
  severity: AuditSeverity;
  isDirect: boolean;
  fixAvailable: "yes" | "no" | "unknown";
  advisories: AuditAdvisoryRef[];
}

export interface AuditTriageReport {
  ok: boolean;
  findings: AuditFinding[];
  entries: AuditPackageEntry[];
  blocking: AuditPackageEntry[];
  totals: { packages: number; blocking: number };
}

const SEVERITY_RANK: Record<AuditSeverity, number> = {
  unknown: 50,
  critical: 40,
  high: 30,
  moderate: 20,
  low: 10,
  info: 0,
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Strip credential material from strings that may appear in advisory URLs
 * or titles. Public GHSA links are left intact.
 */
export function redactPrivacy(value: string): string {
  let text = value;
  text = text.replace(/:\/\/[^/\s:@]+:[^/\s@]+@/g, "://***:***@");
  text = text.replace(
    /([?&](?:token|access_token|auth|key|password|secret|api[_-]?key)=)[^&\s]+/gi,
    "$1***",
  );
  text = text.replace(/\bnpm_[A-Za-z0-9]{20,}\b/g, "npm_***");
  return text;
}

function sanitizeCell(value: string): string {
  return redactPrivacy(value).replace(/\|/g, "/").replace(/\s+/g, " ").trim();
}

function isKnownSeverity(value: string): value is KnownSeverity {
  return (KNOWN_SEVERITIES as readonly string[]).includes(value);
}

function classifySeverity(raw: unknown): AuditSeverity {
  if (typeof raw !== "string" || raw.trim() === "") return "unknown";
  const normalized = raw.trim().toLowerCase();
  if (isKnownSeverity(normalized)) return normalized;
  return "unknown";
}

function classifyFixAvailable(raw: unknown): "yes" | "no" | "unknown" {
  if (raw === false) return "no";
  if (raw === true) return "yes";
  if (isPlainObject(raw) && (raw.name || raw.version)) return "yes";
  return "unknown";
}

function advisoryId(via: Record<string, unknown>): string {
  const url = typeof via.url === "string" ? via.url : "";
  const ghsa = url.match(/GHSA-[a-z0-9-]+/i);
  if (ghsa) return `GHSA-${ghsa[0].slice(5).toLowerCase()}`;
  if (typeof via.source === "number" || typeof via.source === "string") {
    return `npm-${via.source}`;
  }
  return "unidentified";
}

function collectAdvisories(via: unknown): AuditAdvisoryRef[] {
  if (!Array.isArray(via)) return [];
  const refs: AuditAdvisoryRef[] = [];
  const seen = new Set<string>();
  for (const item of via) {
    if (!isPlainObject(item)) continue; // strings are parent-package names
    const id = sanitizeCell(advisoryId(item)).slice(0, 80) || "unidentified";
    const title = sanitizeCell(
      typeof item.title === "string" ? item.title : "",
    ).slice(0, 120);
    const url = sanitizeCell(
      typeof item.url === "string" ? item.url : "",
    ).slice(0, 200);
    const key = `${id}|${url}|${title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ id, title, url });
  }
  return refs;
}

function failedReport(findings: AuditFinding[]): AuditTriageReport {
  return {
    ok: false,
    findings,
    entries: [],
    blocking: [],
    totals: { packages: 0, blocking: 0 },
  };
}

function metadataBlockingCount(metadata: unknown): number {
  if (!isPlainObject(metadata)) return 0;
  const vulns = metadata.vulnerabilities;
  if (!isPlainObject(vulns)) return 0;
  const high =
    typeof vulns.high === "number" && Number.isFinite(vulns.high)
      ? vulns.high
      : 0;
  const critical =
    typeof vulns.critical === "number" && Number.isFinite(vulns.critical)
      ? vulns.critical
      : 0;
  return Math.max(0, high) + Math.max(0, critical);
}

function compareEntries(
  left: AuditPackageEntry,
  right: AuditPackageEntry,
): number {
  const rank = SEVERITY_RANK[right.severity] - SEVERITY_RANK[left.severity];
  if (rank !== 0) return rank;
  return left.packageName.localeCompare(right.packageName);
}

/**
 * Triage an `npm audit --json` document.
 *
 * Accepts a JSON string or a parsed value. Never throws: every failure mode
 * becomes an error finding so CI can always write an artifact.
 */
export function triageNpmAudit(raw: unknown): AuditTriageReport {
  let parsed: unknown;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed === "") {
      return failedReport([
        {
          code: "AUDIT_INVALID_JSON",
          severity: "error",
          message:
            "npm audit produced an empty report. Fail-closed: cannot prove the production tree is clean.",
        },
      ]);
    }
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      return failedReport([
        {
          code: "AUDIT_INVALID_JSON",
          severity: "error",
          message:
            "npm audit output is not valid JSON. Fail-closed: cannot prove the production tree is clean.",
        },
      ]);
    }
  } else {
    parsed = raw;
  }

  if (!isPlainObject(parsed)) {
    return failedReport([
      {
        code: "AUDIT_NOT_OBJECT",
        severity: "error",
        message: "npm audit report is not an object. Fail-closed.",
      },
    ]);
  }

  if (parsed.error !== undefined) {
    const error = isPlainObject(parsed.error) ? parsed.error : {};
    const summary =
      typeof error.summary === "string" && error.summary.trim()
        ? sanitizeCell(error.summary).slice(0, 160)
        : typeof error.code === "string"
          ? sanitizeCell(error.code)
          : "unknown npm audit error";
    return failedReport([
      {
        code: "AUDIT_NPM_ERROR",
        severity: "error",
        message: `npm audit failed (${summary}). Fail-closed: do not skip this gate or ship on an incomplete scan.`,
      },
    ]);
  }

  if (
    parsed.auditReportVersion !== undefined &&
    parsed.auditReportVersion !== 2
  ) {
    return failedReport([
      {
        code: "AUDIT_UNSUPPORTED_VERSION",
        severity: "error",
        message: `unsupported npm audit report version ${JSON.stringify(parsed.auditReportVersion)} (need 2). Fail-closed.`,
      },
    ]);
  }

  const vulnerabilities = parsed.vulnerabilities;
  if (!isPlainObject(vulnerabilities) || Array.isArray(vulnerabilities)) {
    return failedReport([
      {
        code: "AUDIT_MISSING_VULNERABILITIES",
        severity: "error",
        message:
          "npm audit report is missing a vulnerabilities object. Fail-closed: refusing to treat this as a clean scan.",
      },
    ]);
  }

  const findings: AuditFinding[] = [];
  const entries: AuditPackageEntry[] = [];

  for (const [name, details] of Object.entries(vulnerabilities)) {
    const packageName = sanitizeCell(name) || "unknown-package";
    const body = isPlainObject(details) ? details : {};
    const severity = classifySeverity(body.severity);
    const entry: AuditPackageEntry = {
      packageName,
      severity,
      isDirect: body.isDirect === true,
      fixAvailable: classifyFixAvailable(body.fixAvailable),
      advisories: collectAdvisories(body.via),
    };
    entries.push(entry);

    if (severity === "unknown") {
      findings.push({
        code: "AUDIT_UNKNOWN_SEVERITY",
        severity: "error",
        packageName,
        message: `package ${packageName} has an unknown or missing severity — treating as blocking (fail-closed)`,
      });
    } else if ((BLOCKING_SEVERITIES as readonly string[]).includes(severity)) {
      findings.push({
        code: "AUDIT_BLOCKING_ADVISORY",
        severity: "error",
        packageName,
        message: `package ${packageName} has ${severity} production advisories that must be triaged before release`,
      });
    }
  }

  entries.sort(compareEntries);

  const blocking = entries.filter(
    (entry) =>
      entry.severity === "unknown" ||
      (BLOCKING_SEVERITIES as readonly string[]).includes(entry.severity),
  );

  const metaBlocking = metadataBlockingCount(parsed.metadata);
  if (metaBlocking > 0 && blocking.length === 0) {
    findings.push({
      code: "AUDIT_INCONSISTENT_METADATA",
      severity: "error",
      message: `audit metadata reports ${metaBlocking} high/critical vulnerabilities but none were listed under vulnerabilities. Fail-closed.`,
    });
  }

  return {
    ok: findings.length === 0,
    findings,
    entries,
    blocking,
    totals: { packages: entries.length, blocking: blocking.length },
  };
}

function advisoryCell(entry: AuditPackageEntry): string {
  if (entry.advisories.length === 0) return "—";
  return entry.advisories
    .map((adv) => {
      const label =
        adv.id !== "unidentified" ? adv.id : adv.title || "advisory";
      return adv.url ? `${label} (${adv.url})` : label;
    })
    .join("; ");
}

/**
 * Human-readable Markdown report. Never dumps the raw audit JSON, env, or
 * filesystem `nodes` paths.
 */
export function formatAuditReport(report: AuditTriageReport): string {
  const lines = [
    "# Dependency vulnerability triage",
    "",
    "Scope: production dependencies (`npm audit --omit=dev`).",
    "Secrets: none required. This report is derived only from audit JSON.",
    "",
    `Packages with advisories: ${report.totals.packages}`,
    `Blocking (high/critical/unknown): ${report.totals.blocking}`,
    "",
  ];

  if (report.entries.length > 0) {
    lines.push(
      "| Package | Severity | Direct | Fix available | Advisories |",
      "| --- | --- | --- | --- | --- |",
    );
    for (const entry of report.entries) {
      lines.push(
        `| ${entry.packageName} | ${entry.severity} | ${entry.isDirect ? "yes" : "no"} | ${entry.fixAvailable} | ${advisoryCell(entry)} |`,
      );
    }
    lines.push("");
  }

  if (report.findings.length > 0) {
    lines.push("## Findings", "");
    for (const finding of report.findings) {
      const where = finding.packageName ? ` ${finding.packageName}:` : "";
      lines.push(`- \`${finding.code}\`${where} ${finding.message}`);
    }
    lines.push("");
  }

  if (report.ok) {
    lines.push(
      "Result: PASS — no high or critical production dependency advisories were reported.",
    );
  } else {
    lines.push(
      "Result: FAIL — blocking production advisories or an unreadable audit report require triage before release.",
      "Next: upgrade the affected production packages (do not `--force` on main), re-run `npm run audit:deps`, and keep this gate enabled.",
      "Do not skip this check, do not bypass money or deployment controls, and do not attach production secrets to the workflow.",
    );
  }

  return `${lines.join("\n")}\n`;
}
