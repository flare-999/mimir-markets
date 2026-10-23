import { describe, it, expect } from "vitest";
import {
  extractUsdThresholds,
  cryptoThresholdReason,
  CRYPTO_MIN_THRESHOLD_RATIO,
  CRYPTO_MAX_THRESHOLD_RATIO,
} from "../../agents/market-creator/index";

const event = { currentPrice: 100 };

describe("extractUsdThresholds", () => {
  it("parses simple dollar amounts", () => {
    expect(extractUsdThresholds("$123")).toEqual([123]);
  });

  it("parses comma-separated amounts", () => {
    expect(extractUsdThresholds("$100,000")).toEqual([100000]);
  });

  it("parses k suffix", () => {
    expect(extractUsdThresholds("$100k")).toEqual([100000]);
  });

  it("parses M suffix", () => {
    expect(extractUsdThresholds("$1.2M")).toEqual([1200000]);
  });

  it("parses lowercase suffixes", () => {
    expect(extractUsdThresholds("$250k")).toEqual([250000]);
  });

  it("parses multiple thresholds", () => {
    expect(extractUsdThresholds("$10k or $20k")).toEqual([10000, 20000]);
  });

  it("returns empty when no threshold present", () => {
    expect(extractUsdThresholds("price will moon")).toEqual([]);
  });
});

describe("cryptoThresholdReason", () => {
  it("rejects thresholds below the minimum ratio", () => {
    const candidate = { thresholds: [100 * CRYPTO_MIN_THRESHOLD_RATIO / 2] };
    expect(cryptoThresholdReason(candidate, event)).toBeTruthy();
  });

  it("rejects thresholds above the maximum ratio", () => {
    const candidate = { thresholds: [100 * CRYPTO_MAX_THRESHOLD_RATIO * 2] };
    expect(cryptoThresholdReason(candidate, event)).toBeTruthy();
  });

  it("accepts thresholds at the minimum boundary", () => {
    const candidate = { thresholds: [100 * CRYPTO_MIN_THRESHOLD_RATIO] };
    expect(cryptoThresholdReason(candidate, event)).toBeNull();
  });

  it("accepts thresholds at the maximum boundary", () => {
    const candidate = { thresholds: [100 * CRYPTO_MAX_THRESHOLD_RATIO] };
    expect(cryptoThresholdReason(candidate, event)).toBeNull();
  });

  it("rejects when no threshold is provided", () => {
    const candidate = { thresholds: [] };
    expect(cryptoThresholdReason(candidate, event)).toBeTruthy();
  });
});