/**
 * LLM drafting for market creator.
 *
 * This module owns the prompt and the parsing of the model's response
 * into candidate objects. The prompts and caps are deliberately unchanged by the
 * refactor - this is a move, not a rewrite.
 */

import { extractUsdThresholds, cryptoThresholdReason } from "./thresholds.js";

export interface ClaimCandidate {
  question: string;
  resolutionUrl: string;
  deadline: string;
  category?: string;
  threshold?: number;
  /** Source snapshot identity the candidate was drafted from. */
  sourceId?: string;
  /** Capture version of the source snapshot the candidate was drafted from. */
  captureVersion?: string;
  /** Snapshot version used by the shared candidate signature helper. */
  sourceVersion?: string;
  [key: string]: unknown;
}

export interface DraftingContext {
  /** Source material the LLM should read from. */
  sourceText: string;
  /**
   * Identity of the source snapshot the draft was generated from (e.g. URL or
   * document id). Bound onto every candidate so that identical questions drawn
   * from different sources are not collapsed during deduplication.
   */
  sourceId?: string;
  /**
   * Version / capture timestamp of the source snapshot. Changes to the source
   * content over time produce distinct drafts.
   */
  captureVersion?: string;
  /**
   * Normalization policy version(s) in effect for this draft. Included in
   * deduplication keys so that decisions cached under an incompatible policy
   * are invalidated explicitly rather than silently reused.
   */
  normalizationPolicyVersion?: string;
  /** Optional existing questions to avoid duplicating. */
  existingQuestions?: readonly string[];
  /** Maximum number of candidates to request. */
  maxCandidates?: number;
  /** Category hint for the prompt. */
  category?: string;
}

export type LlmCompleter = (prompt: string) => Promise<string>;

const DEFAULT_MAX_CANDIDATES = 5;

/**
 * Build a deterministic deduplication key for a drafted candidate. The key
 * includes the normalization policy version so that a policy change produces
 * a distinct identity, and cached decisions under the old version are not
 * reused.
 */
export function buildDedupeKey(
  candidate: Pick<ClaimCandidate, "question" | "resolutionUrl" | "deadline">,
  normalizationPolicyVersion: string = "unversioned",
): string {
  const normalizedQuestion = candidate.question.trim().toLowerCase().replace(/\s+/g, " ");
  return [
    `policy=${normalizationPolicyVersion}`,
    `q=${normalizedQuestion}`,
    `url=${candidate.resolutionUrl.trim()}`,
    `deadline=${candidate.deadline.trim()}`,
  ].join("|");
}

export function buildDraftingPrompt(context: DraftingContext): string {
  const max = context.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  const categoryLine = context.category ? `Category: ${context.category}\n` : "";
  const existingLine = context.existingQuestions?.length
    ? `Existing questions (do not duplicate):\n${context.existingQuestions.map((q) => `- ${q}`).join("\n")}\n`
    : "";

  return [
    "You are drafting prediction market candidates.",
    "Each candidate must be settleable by fetching ONE resolutionUrl and reading a number or a date out of it.",
    categoryLine,
    existingLine,
    `Return at most ${max} candidates as a JSON array of objects with fields: question, resolutionUrl, deadline (ISO 8601), category, threshold (optional, USD).`,
    "Source material:",
    context.sourceText,
  ].filter(Boolean).join("\n\n");
}

export interface DraftedCandidateResult {
  index: number;
  /** Retained even when another required field is missing. */
  statement: string | null;
  candidate: ClaimCandidate | null;
  rejectionReason: "invalid_candidate" | null;
}

export interface DraftedCandidateBatch {
  entries: DraftedCandidateResult[];
  error: "invalid_draft_response" | null;
}

/** Inspect each draft before filters discard it, for offline batch reports. */
export function parseDraftedCandidateBatch(raw: string): DraftedCandidateBatch {
  const invalid = (): DraftedCandidateBatch => ({ entries: [], error: "invalid_draft_response" });
  if (!raw) return invalid();
  const trimmed = raw.trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*)```/i);
  const jsonText = fenceMatch ? fenceMatch[1] : trimmed;

  const start = jsonText.indexOf("[");
  const end = jsonText.lastIndexOf("]");
  if (start < 0 || end <= start) return invalid();

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText.slice(start, end + 1));
  } catch {
    return invalid();
  }
  if (!Array.isArray(parsed)) return invalid();

  const entries = parsed.map((item, index): DraftedCandidateResult => {
    const rec = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const question = typeof rec.question === "string" ? rec.question.trim() : "";
    const resolutionUrl = typeof rec.resolutionUrl === "string" ? rec.resolutionUrl.trim() : "";
    const deadline = typeof rec.deadline === "string" ? rec.deadline.trim() : "";
    if (!question || !resolutionUrl || !deadline) {
      return { index, statement: question || null, candidate: null, rejectionReason: "invalid_candidate" };
    }
    const candidate: ClaimCandidate = {
      question,
      resolutionUrl,
      deadline,
      category: typeof rec.category === "string" ? rec.category : undefined,
      threshold: typeof rec.threshold === "number" ? rec.threshold : undefined,
      ...(typeof rec.sourceId === "string" ? { sourceId: rec.sourceId } : {}),
      ...(typeof rec.sourceVersion === "string" ? { sourceVersion: rec.sourceVersion } : {}),
      ...(typeof rec.captureVersion === "string" ? { captureVersion: rec.captureVersion } : {}),
    };
    return { index, statement: question, candidate, rejectionReason: null };
  });
  return { entries, error: null };
}

/**
 * Parse candidates, tolerating code fences and surrounding prose.
 * Compatibility API: malformed responses/entries still produce no candidate.
 */
export function parseDraftedCandidates(raw: string): ClaimCandidate[] {
  return parseDraftedCandidateBatch(raw).entries.flatMap(({ candidate }) => candidate ? [candidate] : []);
}

/**
 * Drop candidates whose crypto threshold fails the sanity check.
 * Candidates without a threshold are kept unchanged.
 */
export function filterUnsafeCryptoThresholds(
  candidates: readonly ClaimCandidate[],
): ClaimCandidate[] {
  return candidates.filter((candidate) => {
    if (candidate.threshold === undefined) return true;
    return cryptoThresholdReason(candidate.threshold) === null;
  });
}

/**
 * Draft candidates by calling the provided completer with the drafting
 * prompt, then parsing and sanitising the response.
 */
export async function draftClaimCandidates(
  completer: LlmCompleter,
  context: DraftingContext,
): Promise<ClaimCandidate[]> {
  const prompt = buildDraftingPrompt(context);
  const raw = await completer(prompt);
  const parsed = parseDraftedCandidates(raw).map((candidate) => ({
    ...candidate,
    sourceId: context.sourceId,
    captureVersion: context.captureVersion,
  }));
  return filterUnsafeCryptoThresholds(parsed);
}

/**
 * Exported for tests and for callers that want to inspect threshold
 * mentions in a drafted question without running the full filter.
 */
export { extractUsdThresholds, cryptoThresholdReason };
