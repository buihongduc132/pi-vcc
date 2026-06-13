import type { NormalizedBlock } from "../types";
import { assertSafeComplexity } from "../core/regex-utils";

export interface ReferenceExtract {
  urls: string[];
  githubRefs: string[];
  versions: string[];
  branches: string[];
  commitRefs: string[];
}

export interface ReferencesOptions {
  enabled?: boolean;
  /** Extra URL regex strings (compiled and applied alongside built-in). */
  extraUrlPatterns?: string[];
  /** Extra GitHub ref regex strings (full match added to githubRefs). */
  extraGithubRefPatterns?: string[];
  /** Extra version regex strings (capture group 1 or full match). */
  extraVersionPatterns?: string[];
  /** Extra branch regex strings (full match added to branches). */
  extraBranchPatterns?: string[];
}

// ── Regex patterns ──

// URLs: http:// or https:// followed by non-whitespace, strip trailing punctuation
const URL_RE = /https?:\/\/\S+/g;
const TRAILING_PUNCT_RE = /[.,;:!?)\]}>]+$/;

// GitHub refs
const BARE_ISSUE_RE = /#(\d+)/g;
const PR_REF_RE = /\b(PR|pr)\s*#(\d+)/g;
const OWNER_REPO_RE = /\b([a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)\/([a-zA-Z0-9_.-]+)\b/g;
// Filter: owner must be 2+ chars, repo must be 2+ chars, and not look like a file path
const REPO_FILTER = (owner: string, repo: string): boolean => {
  if (owner.length < 2 || repo.length < 2) return false;
  if (/^\./.test(repo)) return false;
  const skipOwners = new Set(["src", "lib", "dist", "build", "test", "tests", "pkg", "cmd", "web", "app", "docs", "scripts", "assets", "public", "static", "vendor"]);
  if (skipOwners.has(owner.toLowerCase())) return false;
  return true;
};

// Versions: v1.2.3 or bare 1.2.3 (but NOT IP octets)
const VERSION_RE = /\b(v?\d+\.\d+\.\d+)\b/g;
const isIPContext = (text: string, index: number): boolean => {
  const before = text.slice(Math.max(0, index - 20), index);
  const after = text.slice(index, Math.min(text.length, index + 30));
  if (/\d+\.\d+\.\d+\.\d+/.test(after)) return true;
  if (/\d+\.\d+\.\d+\.\d+/.test(before + after.slice(0, 15))) return true;
  return false;
};

// Branches: feat/xxx, fix/xxx, etc.
const BRANCH_RE = /\b(?:feat|fix|hotfix|release|chore|refactor|docs|test)\/[\w-]+\b/g;

// Commit refs: 7-12 hex chars (only in user/assistant blocks)
const COMMIT_REF_RE = /\b([0-9a-f]{7,12})\b/g;
const isLikelyHexHash = (s: string): boolean => /[a-f]/i.test(s);

// ── Limits ──
const URL_LIMIT = 10;
const GITHUB_REF_LIMIT = 8;
const VERSION_LIMIT = 5;
const BRANCH_LIMIT = 5;
const COMMIT_REF_LIMIT = 5;

// ── Helpers ──

const cleanUrl = (raw: string): string => raw.replace(TRAILING_PUNCT_RE, "");

const collectTextFromBlocks = (blocks: NormalizedBlock[]): string[] => {
  const texts: string[] = [];
  for (const b of blocks) {
    if (b.kind === "user" || b.kind === "assistant") {
      texts.push(b.text);
    }
  }
  return texts;
};

/** Compile an array of regex strings into RegExp objects (global).
 *  Each pattern is checked for ReDoS complexity before compilation.
 *  Patterns that fail complexity check or regex syntax are silently skipped. */
const compilePatterns = (patterns: string[] | undefined): RegExp[] => {
  if (!patterns || patterns.length === 0) return [];
  return patterns.map((p) => {
    try { assertSafeComplexity(p); return new RegExp(p, "g"); } catch { return null; }
  }).filter((r): r is RegExp => r !== null);
};

// ── Extraction ──

export const extractReferences = (blocks: NormalizedBlock[], options?: ReferencesOptions): ReferenceExtract => {
  if (options?.enabled === false) {
    return { urls: [], githubRefs: [], versions: [], branches: [], commitRefs: [] };
  }

  const urls = new Set<string>();
  const githubRefs = new Set<string>();
  const versions = new Set<string>();
  const branches = new Set<string>();
  const commitRefs = new Set<string>();

  const extraUrlRes = compilePatterns(options?.extraUrlPatterns);
  const extraGhRefRes = compilePatterns(options?.extraGithubRefPatterns);
  const extraVersionRes = compilePatterns(options?.extraVersionPatterns);
  const extraBranchRes = compilePatterns(options?.extraBranchPatterns);

  const texts = collectTextFromBlocks(blocks);

  for (const text of texts) {
    // ── URLs ──
    if (urls.size < URL_LIMIT) {
      for (const m of text.matchAll(URL_RE)) {
        const cleaned = cleanUrl(m[0]);
        if (cleaned && urls.size < URL_LIMIT) urls.add(cleaned);
      }
      // Extra URL patterns
      for (const re of extraUrlRes) {
        for (const m of text.matchAll(re)) {
          const val = m[1] ?? m[0];
          const cleaned = cleanUrl(val);
          if (cleaned && urls.size < URL_LIMIT) urls.add(cleaned);
        }
      }
    }

    // ── GitHub refs ──
    if (githubRefs.size < GITHUB_REF_LIMIT) {
      // Built-in: bare issue numbers
      for (const m of text.matchAll(BARE_ISSUE_RE)) {
        const ref = `#${m[1]}`;
        if (githubRefs.size < GITHUB_REF_LIMIT) githubRefs.add(ref);
      }
      // Built-in: PR references
      for (const m of text.matchAll(PR_REF_RE)) {
        const ref = `${m[1]} #${m[2]}`;
        if (githubRefs.size < GITHUB_REF_LIMIT) githubRefs.add(ref);
      }
      // Built-in: owner/repo
      for (const m of text.matchAll(OWNER_REPO_RE)) {
        if (REPO_FILTER(m[1], m[2])) {
          const ref = `${m[1]}/${m[2]}`;
          if (githubRefs.size < GITHUB_REF_LIMIT) githubRefs.add(ref);
        }
      }
      // Built-in: GitHub URLs → owner/repo#issue
      for (const m of text.matchAll(/https?:\/\/github\.com\/([a-zA-Z0-9-]+)\/([a-zA-Z0-9_.-]+)\/(?:issues|pull)\/(\d+)/g)) {
        const ref = `${m[1]}/${m[2]}#${m[3]}`;
        if (githubRefs.size < GITHUB_REF_LIMIT) githubRefs.add(ref);
      }
      // Extra GitHub ref patterns (full match)
      for (const re of extraGhRefRes) {
        for (const m of text.matchAll(re)) {
          const val = m[1] ?? m[0];
          if (githubRefs.size < GITHUB_REF_LIMIT) githubRefs.add(val);
        }
      }
    }

    // ── Versions ──
    if (versions.size < VERSION_LIMIT) {
      for (const m of text.matchAll(VERSION_RE)) {
        if (!isIPContext(text, m.index ?? 0)) {
          if (versions.size < VERSION_LIMIT) versions.add(m[1]);
        }
      }
      // Extra version patterns
      for (const re of extraVersionRes) {
        for (const m of text.matchAll(re)) {
          const val = m[1] ?? m[0];
          if (versions.size < VERSION_LIMIT) versions.add(val);
        }
      }
    }

    // ── Branches ──
    if (branches.size < BRANCH_LIMIT) {
      for (const m of text.matchAll(BRANCH_RE)) {
        if (branches.size < BRANCH_LIMIT) branches.add(m[0]);
      }
      // Extra branch patterns
      for (const re of extraBranchRes) {
        for (const m of text.matchAll(re)) {
          if (branches.size < BRANCH_LIMIT) branches.add(m[0]);
        }
      }
    }

    // ── Commit refs ──
    if (commitRefs.size < COMMIT_REF_LIMIT) {
      for (const m of text.matchAll(COMMIT_REF_RE)) {
        if (isLikelyHexHash(m[1])) {
          if (commitRefs.size < COMMIT_REF_LIMIT) commitRefs.add(m[1]);
        }
      }
    }
  }

  return {
    urls: [...urls].slice(0, URL_LIMIT),
    githubRefs: [...githubRefs].slice(0, GITHUB_REF_LIMIT),
    versions: [...versions].slice(0, VERSION_LIMIT),
    branches: [...branches].slice(0, BRANCH_LIMIT),
    commitRefs: [...commitRefs].slice(0, COMMIT_REF_LIMIT),
  };
};

export const formatReferences = (refs: ReferenceExtract): string[] => {
  const lines: string[] = [];
  if (refs.urls.length > 0) lines.push(`URL: ${refs.urls.join(", ")}`);
  if (refs.githubRefs.length > 0) lines.push(`GitHub: ${refs.githubRefs.join(", ")}`);
  if (refs.versions.length > 0) lines.push(`Version: ${refs.versions.join(", ")}`);
  if (refs.branches.length > 0) lines.push(`Branch: ${refs.branches.join(", ")}`);
  if (refs.commitRefs.length > 0) lines.push(`CommitRef: ${refs.commitRefs.join(", ")}`);
  return lines;
};
