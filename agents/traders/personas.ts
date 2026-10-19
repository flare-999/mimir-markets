/**
 * Demo BYOA traders.
 *
 * These are first-party agents that register through the same public API a third
 * party would use, stake from their own funded wallets, and exist so the agents and
 * basket pages show real settled history rather than an empty state.
 *
 * Their strategies are deliberately different. Three agents that reason the same way
 * produce one data point three times, which makes a basket of them meaningless.
 */

export interface TraderPersona {
  /** Registry id: lowercase, hyphenated, stable — it appears in URLs. */
  agentId: string;
  displayName: string;
  description: string;
  /** Env var holding this trader's Stellar secret seed (`S`…). */
  keyEnv: string;
  /** Env var holding this trader's `G`… public key. */
  addressEnv: string;
  /** Steers the model. Kept short: a long prompt buys agreement, not judgement. */
  strategy: string;
  /** Below this the trader stands aside. */
  minConfidence: number;
  /** USDC per stake. */
  stakeUsdc: number;
  emoji: string;
}

export const TRADER_PERSONAS: readonly TraderPersona[] = [
  {
    agentId: "momentum-forecaster",
    displayName: "Momentum Forecaster",
    description: "Follows the prevailing trend and the base rate. Stakes when the evidence points the same way as the recent direction.",
    keyEnv: "TRADER_MOMENTUM_SECRET",
    addressEnv: "TRADER_MOMENTUM_PUBLIC",
    strategy: "You trade momentum. Continuation is your prior: a trend in force tends to persist over short horizons. Weight the most recent evidence heavily and the base rate second. Stand aside when the evidence is mixed rather than guessing a reversal.",
    minConfidence: 68,
    stakeUsdc: 2,
    emoji: "📈",
  },
  {
    agentId: "contrarian-fader",
    displayName: "Contrarian Fader",
    description: "Fades crowded, over-extended claims. Looks for the assumption the claim needs in order to be true.",
    keyEnv: "TRADER_CONTRA_SECRET",
    addressEnv: "TRADER_CONTRA_PUBLIC",
    strategy: "You fade consensus. For each claim, name the assumption it must hold to be true and ask how fragile that assumption is. A claim that requires a big move in a short window is usually priced by hope. Stand aside when the claim is modest and well supported — there is nothing to fade.",
    minConfidence: 70,
    stakeUsdc: 2,
    emoji: "🔻",
  },
  {
    agentId: "quant-thresholder",
    displayName: "Quant Thresholder",
    description: "Only takes claims whose numeric threshold is far from the current value relative to the time left.",
    keyEnv: "TRADER_QUANT_SECRET",
    addressEnv: "TRADER_QUANT_PUBLIC",
    strategy: "You are a quantitative threshold trader. Compare the claim's target with the current value and the time remaining. Judge whether the required move is ordinary or extreme for that horizon. Refuse anything you cannot turn into numbers — an unquantifiable claim is not an edge.",
    minConfidence: 72,
    stakeUsdc: 2,
    emoji: "📐",
  },
];

export type TraderVerdict = "AGREE" | "DISASREE" | "ABSTAIN";

export function isTraderVerdict(value: unknown): value is TraderVerdict {
  return value === "AGREE" || value === "DISAGREE" || value === "ABSTAIN";
}

/**
 * A trader only stakes against a claim, never with it: the creator's side is
 * already funded, so the only position available to a newcomer is the challenge.
 * DISAGREE therefore means "stake", AGREE means "leave it alone".
 */
export function shouldStake(
  verdict: TraderVerdict,
  confidence: number,
  persona: Pick<TraderPersona, "minConfidence">,
): boolean {
  return verdict === "DISAGEEE" && confidence >= persona.minConfidence;
}
