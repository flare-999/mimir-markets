import "server-only";

import { readFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

import { normalizeResolutionSource } from "@/lib/constants";
import {
  sanitizeModerationResult,
  type ClaimModerationDecision,
  type ClaimModerationResult,
  type ClaimModerationViolationCode,
  type GeminiModerationPayload,
} from "@/lib/moderation/sanitize-moderation-result";

export type {
  ClaimModerationDecision,
  ClaimModerationViolationCode,
  ClaimModerationResult,
};
export { sanitizeModerationResult };

const LOCAL_BLOCK_PATTERNS: Array<{
  code: ClaimModerationViolationCode;
  re: RegExp;
}> = [
  // Death / self-harm (ES/EN light coverage)
  {
    code: "death_self_harm",
    re: /\b(suicid|suicidarse|autolesi|self[-\s]?harm|kill\s+myself)\b/i,
  },
  {
    code: "death_self_harm",
    re: /\b(morir|muere|muerte|asesin|mat[ao]n|killed|die|death|murder)\b/i,
  },
  // Violence / harm
  {
    code: "violence_harm",
    re: /\b(violaci|rape|raped|abuse|abus(?:o|ar)|golpear|disparar|shoot|stab|bomb|terror)\b/i,
  },
  // Doxxing / personal data
  {
    code: "doxxing_personal_data",
    re: /\b(doxx|doxxing|direcci[oó]n|domicilio|tel[eé]fono|dni|passport|ssn)\b/i,
  },
];

const DEFAULT_GEMINI_MODEL =
  process.env.CLAIM_MODERATION_MODEL || "gemini-2.5-flash";

export type ClaimModerationInput = {
  question: string;
  creator_position: string;
  opponent_position: string;
  category: string;
  settlement_rule: string;
  resolution_url: string;
};

function getModerationSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      decision: { type: "string", enum: ["allow", "review", "block"] },
      violationCodes: {
        type: "array",
        minItems: 0,
        maxItems: 5,
        items: {
          type: "string",
          enum: [
            "death_self_harm",
            "violence_harm",
            "hate_harassment",
            "sexual_minors",
            "nonconsensual_sexual",
            "illegal_facilitation",
            "doxxing_personal_data",
            "medical_privacy",
            "graphic_content",
            "other_policy",
          ],
        },
      },
      confidence: { type: "integer", minimum: 0, maximum: 100 },
    },
    required: ["decision", "violationCodes", "confidence"],
  };
}

async function readPolicyMarkdown() {
  const policyPath = path.join(process.cwd(), "lib", "moderation", "policy.md");
  const text = await readFile(policyPath, "utf8");
  const normalized = text.replace(/\r\n/g, "\n").trim();
  const hash = crypto.createHash("sha256").update(normalized).digest("hex");
  return { policy: normalized, policyVersion: `sha256:${hash.slice(0, 12)}` };
}

function buildPrompt(args: {
  policy: string;
  policyVersion: string;
  locale: string;
  input: ClaimModerationInput;
}) {
  const normalizedSource = normalizeResolutionSource(args.input.resolution_url);

  return [
    "You are a safety and policy enforcement system for Mimir, a stake-backed claim duel product.",
    "Classify the user's claim against the provided policy.",
    "Return ONLY valid JSON that matches the given JSON schema.",
    "Do not include any preamble, markdown, or explanation. The first character of your response must be '{'.",
    "",
    "Policy markdown (authoritative):",
    args.policy,
    "",
    "Policy version (for traceability):",
    args.policyVersion,
    "",
    "User-submitted claim (to moderate):",
    `- question: ${args.input.question}`,
    `- creator_position: ${args.input.creator_position}`,
    `- opponent_position: ${args.input.opponent_position}`,
    `- category: ${args.input.category}`,
    `- settlement_rule: ${args.input.settlement_rule}`,
    `- resolution_url: ${normalizedSource || args.input.resolution_url}`,
    "",
    "Decision rules:",
    "- If it clearly violates an Always block rule, decision must be block.",
    "- If it is ambiguous but could be harmful, decision should be review.",
    "- Otherwise, decision should be allow.",
    "- Do NOT over-block harmless, non-violent claims (e.g., public figure announcements like marriage or publicly announced pregnancy/birth) when they are settled from public sources.",
    "- violationCodes must be empty for allow.",
    "- If blocked or review, include 1-3 violationCodes that best match the issue.",
    "- Choose the most specific code available; use other_policy only if none fit.",
  ].join("\n");
}

async function callGemini(prompt: string) {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "Moderation is not configured. Add GEMINI_API_KEY on the server."
    );
  }

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_GEMINI_MODEL}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 800,
          responseMimeType: "application/json",
          responseJsonSchema: getModerationSchema(),
        },
      }),
      signal: AbortSignal.timeout(20000),
    }
  );

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(
      `Moderation request failed (${response.status}): ${
        errorText || "Unknown error"
      }`
    );
  }

  const payload = await response.json();
  const text = payload?.candidates?.[0]?.content?.parts
    ?.map((part: { text?: string }) => part?.text || "")
    .join("")
    .trim();

  if (!text) {
    throw new Error("Moderation returned an empty response");
  }

  const tryParse = (raw: string) => {
    try {
      return JSON.parse(raw) as GeminiModerationPayload;
    } catch {
      return null;
    }
  };

  const extractFirstJsonObject = (raw: string) => {
    const start = raw.indexOf("{");
    if (start < 0) return "";
    let depth = 0;
    for (let i = start; i < raw.length; i++) {
      const ch = raw[i];
      if (ch === "{") depth++;
      if (ch === "}") depth--;
      if (depth === 0) {
        return raw.slice(start, i + 1);
      }
    }
    return "";
  };

  // 1) Best case: it's pure JSON.
  const direct = tryParse(text);
  if (direct) return direct;

  // 2) Strip common markdown fences and retry.
  const unfenced = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  const unfencedParsed = tryParse(unfenced);
  if (unfencedParsed) return unfencedParsed;

  // 3) Extract the first JSON object substring.
  const firstObj = extractFirstJsonObject(unfenced).trim();
  if (firstObj) {
    const sliced = tryParse(firstObj);
    if (sliced) return sliced;
  }

  throw new Error(
    `Moderation returned non-JSON output. First 200 chars: ${unfenced.slice(0, 200)}`
  );
}

export async function moderateClaim(args: {
  input: ClaimModerationInput;
  locale?: string;
}): Promise<ClaimModerationResult> {
  const locale = args.locale === "es" ? "es" : "en";
  const combinedText = [
    args.input.question,
    args.input.creator_position,
    args.input.opponent_position,
    args.input.settlement_rule,
  ]
    .join(" ")
    .trim();

  // Rules-first: block obvious disallowed topics without spending Gemini quota.
  for (const pattern of LOCAL_BLOCK_PATTERNS) {
    if (pattern.re.test(combinedText)) {
      const result: ClaimModerationResult = {
        decision: "block",
        violationCodes: [pattern.code],
        confidence: 100,
        policyVersion: "local-rules:v1",
      };
      console.log(
        JSON.stringify({
          audit: "claim_moderation",
          input: args.input,
          decision: result.decision,
          violationCodes: result.violationCodes,
          confidence: result.confidence,
          policyVersion: result.policyVersion,
          locale,
        })
      );
      return result;
    }
  }

  const { policy, policyVersion } = await readPolicyMarkdown();
  const prompt = buildPrompt({
    policy,
    policyVersion,
    locale,
    input: args.input,
  });
  const raw = await callGemini(prompt);
  const result = sanitizeModerationResult({ raw, policyVersion, locale });
  
  console.log(
    JSON.stringify({
      audit: "claim_moderation",
      input: args.input,
      decision: result.decision,
      violationCodes: result.violationCodes,
      confidence: result.confidence,
      policyVersion: result.policyVersion,
      locale,
    })
  );

  return result;
}

