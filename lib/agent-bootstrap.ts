/**
 * Shared startup guards for the worker agents (oracle, market-creator, council).
 */

/** Exits the process when any required env var is missing. */
export function requireEnv(names: string[]): void {
  for (const v of names) {
    if (!process.env[v]) {
      console.error(`${v} env var is required`);
      process.exit(1);
    }
  }
}

const LLM_KEY_VARS = [
  "GEMINI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GROQ_API_KEY",
  "GROQ_API_KEYS",
  "OPENROUTER_API_KEY",
] as const;

/** Exits the process unless at least one LLM provider key is configured. */
export function requireAnyLLMKey(): void {
  if (!LLM_KEY_VARS.some((v) => process.env[v]?.trim())) {
    console.error(
      "Set at least one LLM key: GEMINI_API_KEY, ANTHROPIC_API_KEY, GROQ_API_KEY/GROQ_API_KEYS, or OPENROUTER_API_KEY",
    );
    process.exit(1);
  }
}

/**
 * Serializes LLM calls: consecutive invocations of the returned gate are at
 * least `ms` apart, so a burst of claims doesn't trip free-tier RPM limits.
 *
 * The next slot is reserved synchronously on entry, so concurrent callers
 * each receive a distinct slot instead of computing the same wait and rushing
 * through together.
 */
export function createThrottle(ms: number): () => Promise<void> {
  let nextAt = 0;
  return async () => {
    if (ms <= 0) return;
    const now = Date.now();
    const slot = Math.max(now, nextAt);
    nextAt = slot + ms;
    const wait = slot - now;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  };
}

/**
 * Worker-scoped Gemini key: promotes e.g. ORACLE_GEMINI_API_KEY to
 * GEMINI_API_KEY for this process so each worker consumes from its own
 * free-tier RPM bucket. Trimmed on assignment so trailing whitespace pasted
 * into a dashboard env UI can't slip into the Authorization header.
 */
export function applyWorkerGeminiKey(envVar: string): void {
  const k = process.env[envVar]?.trim();
  if (k) process.env.GEMINI_API_KEY = k;
}
