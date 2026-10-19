/**
 * Hard upper bound enforced by the on-chain contract.
 * Must match the contract's `MAX_CHALLENGERS` constant.
 */
export const CONTRACT_MAX_CHALLENGERS = 100;

/**
 * Default used when `MARKET_CREATOR_MAX_CHALLENGERS` is not set.
 */
export const DEFAULT_MAX_CHALLENGERS_FALLBACK = 10;

export interface ParseMaxChallengersOptions {
  /** Raw env value (e.g. `process.env.MARKET_CREATOR_MAX_CHALLENGERS`). */
  raw?: string | undefined | null;
  /** Upper bound enforced by the contract. Defaults to `CONTRACT_MAX_CHALLENGERS`. */
  contractMax?: number;
  /** Value used when `raw` is unset/empty. Defaults to `DEFAULT_MAX_CHALLENGERS_FALLBACK`. */
  defaultValue?: number;
  /** Name of the env var for error messages. */
  envName?: string;
}

/**
 * Parse and validate the configured max-challengers value.
 *
 * The value must be an integer between 1 and the contract's `MAX_CHALLENGERS`.
 * Throws a clear, actionable error otherwise so the agent fails fast at startup.
 */
export function parseMaxChallengers(options: ParseMaxChallengersOptions = {}): number {
  const {
    raw,
    contractMax = CONTRACT_MAX_CHALLENGERS,
    defaultValue = DEFAULT_MAX_CHALLENGERS_FALLBACK,
    envName = 'MARKET_CREATOR_MAX_CHALLENGERS',
  } = options;

  if (!Number.isInteger(contractMax) || contractMax < 1) {
    throw new Error(
      `Invalid contract max challengers (${contractMax}): must be a positive integer.`,
    );
  }

  if (!Number.isInteger(defaultValue) || defaultValue < 1 || defaultValue > contractMax) {
    throw new Error(
      `Invalid default max challengers (${defaultValue}): must be an integer between 1 and ${contractMax}.`,
    );
  }

  if (raw === undefined || raw === null || raw.trim() === '') {
    return defaultValue;
  }

  const trimmed = raw.trim();
  // Only allow plain integer literals; reject decimals, exponents, hex, etc.
  if (!/^[0-9]+$/.test(trimmed)) {
    throw new Error(
      `Invalid ${envName} "${raw}": must be an integer between 1 and ${contractMax}.`,
    );
  }

  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > contractMax) {
    throw new Error(
      `Invalid ${envName} "${raw}": must be an integer between 1 and ${contractMax}.`,
    );
  }

  return parsed;
}
