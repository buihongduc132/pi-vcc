import type { NormalizedBlock } from "../types";
import { clip, nonEmptyLines } from "../core/content";

export interface SignalsOptions {
  enabled?: boolean;
  /** Extra constraint regex strings (applied alongside built-in). */
  extraConstraintPatterns?: string[];
  /** Extra decision regex strings (applied alongside built-in). */
  extraDecisionPatterns?: string[];
  /** Extra status keywords (added to built-in DONE|TODO|WIP|blocked|resolved). */
  extraStatusKeywords?: string[];
}

// ─── Pattern definitions ────────────────────────────────────────────

const CONSTRAINT_RE =
  /\b(don'?t|must not|cannot|forbidden|disallowed|off[- ]limits|out of scope|excluded|do not)\b/i;

const DECISION_RE =
  /\b(decided|let'?s use|going with|chose|we'?ll use)\b/i;

const DEFAULT_STATUS_KEYWORDS = ["DONE", "TODO", "WIP", "blocked", "resolved"];

// Build a regex that matches a status keyword at start of line or after [.!?;:\-—]
const buildStatusPattern = (line: string, extraKeywords?: string[]): boolean => {
  const keywords = extraKeywords && extraKeywords.length > 0
    ? [...DEFAULT_STATUS_KEYWORDS, ...extraKeywords]
    : DEFAULT_STATUS_KEYWORDS;
  for (const kw of keywords) {
    const re = new RegExp(`(?:^|[.!?;:\\-—])\\s*${kw}\\b`, "i");
    if (re.test(line)) return true;
  }
  return false;
};

/** Compile an array of regex strings into RegExp objects. */
const compilePatterns = (patterns: string[] | undefined): RegExp[] => {
  if (!patterns || patterns.length === 0) return [];
  return patterns.map((p) => {
    try { return new RegExp(p, "i"); } catch { return null; }
  }).filter((r): r is RegExp => r !== null);
};

// ─── Types ──────────────────────────────────────────────────────────

export interface SignalExtract {
  constraints: string[];
  decisions: string[];
  statuses: string[];
}

// ─── Extractor ──────────────────────────────────────────────────────

const MIN_LINE_LENGTH = 15;
const MAX_LINE_LENGTH = 200;
const CAP_CONSTRAINTS = 5;
const CAP_DECISIONS = 5;
const CAP_STATUSES = 5;

export const extractSignals = (blocks: NormalizedBlock[], options?: SignalsOptions): SignalExtract => {
  if (options?.enabled === false) {
    return { constraints: [], decisions: [], statuses: [] };
  }

  const extraConstraintRes = compilePatterns(options?.extraConstraintPatterns);
  const extraDecisionRes = compilePatterns(options?.extraDecisionPatterns);

  const constraints: string[] = [];
  const decisions: string[] = [];
  const statuses: string[] = [];

  const seenConstraints = new Set<string>();
  const seenDecisions = new Set<string>();
  const seenStatuses = new Set<string>();

  for (const b of blocks) {
    if (b.kind !== "user" && b.kind !== "assistant") continue;
    const isUser = b.kind === "user";

    for (const line of nonEmptyLines(b.text)) {
      const trimmed = line.trim();
      if (trimmed.length < MIN_LINE_LENGTH) continue;
      if (trimmed.length > 500) continue;
      if (trimmed.endsWith("?")) continue;

      // ── Constraints (user only) ────────────────────────────────
      if (isUser && constraints.length < CAP_CONSTRAINTS) {
        let matched = CONSTRAINT_RE.test(trimmed);
        if (!matched) {
          for (const re of extraConstraintRes) {
            if (re.test(trimmed)) { matched = true; break; }
          }
        }
        if (matched) {
          const clipped = clip(trimmed, MAX_LINE_LENGTH);
          const key = clipped.toLowerCase();
          if (!seenConstraints.has(key)) {
            seenConstraints.add(key);
            constraints.push(clipped);
          }
        }
      }

      // ── Decisions (user only) ──────────────────────────────────
      if (isUser && decisions.length < CAP_DECISIONS) {
        let matched = DECISION_RE.test(trimmed);
        if (!matched) {
          for (const re of extraDecisionRes) {
            if (re.test(trimmed)) { matched = true; break; }
          }
        }
        if (matched) {
          const clipped = clip(trimmed, MAX_LINE_LENGTH);
          const key = clipped.toLowerCase();
          if (!seenDecisions.has(key)) {
            seenDecisions.add(key);
            decisions.push(clipped);
          }
        }
      }

      // ── Statuses (user + assistant) ────────────────────────────
      if (statuses.length < CAP_STATUSES && buildStatusPattern(trimmed, options?.extraStatusKeywords)) {
        const clipped = clip(trimmed, MAX_LINE_LENGTH);
        const key = clipped.toLowerCase();
        if (!seenStatuses.has(key)) {
          seenStatuses.add(key);
          statuses.push(clipped);
        }
      }
    }
  }

  return { constraints, decisions, statuses };
};

// ─── Formatter ──────────────────────────────────────────────────────

export const formatSignals = (signals: SignalExtract): string[] => {
  const lines: string[] = [];
  for (const c of signals.constraints) lines.push(`Constraint: ${c}`);
  for (const d of signals.decisions) lines.push(`Decision: ${d}`);
  for (const s of signals.statuses) lines.push(`Status: ${s}`);
  return lines;
};
