import { describe, it, expect } from "vitest";
import { parseCouncilConfig } from "../../agents/council/shared/config.js";

describe("parseCouncilConfig", () => {
  it("returns today's defaults when every variable is unset", () => {
    const result = parseCouncilConfig({});

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    expect(result.config).toEqual({
      pollIntervalMs: 5_000,
      maxClaims: 10,
      decisionDelayMs: 1_000,
      peerReadsPerPersona: 3,
      peerReadDelayMs: 500,
      peerReadCapUsdc: 1,
      llmThrottleMs: 250,
    });
  });

 it("parses valid overrides", () => {
    const result = parseCouncilConfig({
      COUNCIL_POLL_INTERVAL_MS: "15000",
      COUNCIL_MAX_CLAIMS: "25",
      COUNCIL_DECISION_DELAY_MS: "2000",
      COUNCIL_PEER_READS_PER_PERSONA: "5",
      COUNCIL_PEER_READ_DELAY_MS: "750",
      COUNCIL_PEER_READ_CAP_USDC: "2.5",
      COUNCIL_LLM_THROTTLE_MS: "1000",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    expect(result.config).toEqual({
      pollIntervalMs: 15_000,
      maxClaims: 25,
      decisionDelayMs: 2_000,
      peerReadsPerPersona: 5,
      peerReadDelayMs: 750,
      peerReadCapUsdc: 2.5,
      llmThrottleMs: 1_000,
    });
  });

  it("reports a non-numeric value", () => {
    const result = parseCouncilConfig({ COUNCIL_POLL_INTERVAL_MS: "abc" });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.errors.join("\n")).toContain("COUNCIL_POLL_INTERVAL_MS");
  });

  it("reports a negative value", () => {
    const result = parseCouncilConfig({ COUNCIL_MAX_CLAIMS: "-1" });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.errors.join("\n")).toContain("COUNCIL_MAX_CLAIMS");
  });

  it("reports a non-integer where an integer is required", () => {
    const result = parseCouncilConfig({ COUNCIL_MAX_CLAIMS: "2.5" });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.errors.join("\n")).toContain("COUNCIL_MAX_CLAIMS");
  });

 it("reports a value above the maximum", () => {
    const result = parseCouncilConfig({ COUNCIL_PEER_READ_CAP_USDC: "99999999" });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.errors.join("\n")).toContain("COUNCIL_PEER_READ_CAP_USDC");
  });

  it("reports multiple errors together", () => {
    const result = parseCouncilConfig({
      COUNCIL_POLL_INTERVAL_MS: "abc",
      COUNCIL_MAX_CLAIMS: "-1",
      COUNCIL_DECISION_DELAY_MS: "2.5",
      COUNCIL_PEER_READS_PER_PERSONA: "x",
      COUNCIL_PEER_READ_DELAY_MS: "-5",
      COUNCIL_PEER_READ_CAP_USDC: "99999999",
      COUNCIL_LLM_THROTTLE_MS: "-1",
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");

    const message = result.errors.join("\n");
    for (const name of [
      "COUNCIL_POLL_INTERVAL_MS",
      "COUNCIL_MAX_CLAIMS",
      "COUNCIL_DECISION_DELAY_MS",
      "COUNCIL_PEER_REATS_PER_PERSONA",
      "COUNCIL_PEER_READ_DELAY_MS",
      "COUNCIL_PEER_READ_CAP_USDC",
      "COUNCIL_LLM_THROTTLE_MS",
    ]) {
      expect(message).toContain(name);
    }
  });
});
