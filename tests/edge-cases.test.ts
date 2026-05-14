import { describe, it, expect } from "bun:test";
import { extractReferences, formatReferences } from "../src/extract/references";
import { extractSignals, formatSignals } from "../src/extract/signals";
import { compile } from "../src/core/summarize";
import { buildSections } from "../src/core/build-sections";
import type { NormalizedBlock } from "../src/types";

// ═══════════════════════════════════════════════════════════════
// Edge cases for references extractor
// ═══════════════════════════════════════════════════════════════

describe("references edge cases", () => {
  it("strips trailing punctuation from URLs", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "See https://example.com/docs." },
    ];
    const r = extractReferences(blocks);
    expect(r.urls[0]).toBe("https://example.com/docs");
  });

  it("strips trailing paren from URL inside parens", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "Check the docs (https://example.com/api)" },
    ];
    const r = extractReferences(blocks);
    expect(r.urls[0]).toBe("https://example.com/api");
  });

  it("handles URL with port number", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "Service at http://100.114.135.99:4747" },
    ];
    const r = extractReferences(blocks);
    expect(r.urls[0]).toBe("http://100.114.135.99:4747");
  });

  it("handles URL with fragment", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "See https://docs.example.com/api/v2#section" },
    ];
    const r = extractReferences(blocks);
    expect(r.urls[0]).toBe("https://docs.example.com/api/v2#section");
  });

  it("handles multiple URLs in one message", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "Check https://example.com and https://other.com/docs" },
    ];
    const r = extractReferences(blocks);
    expect(r.urls.length).toBe(2);
  });

  it("deduplicates same URL across blocks", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "See https://example.com" },
      { kind: "assistant", text: "I checked https://example.com" },
    ];
    const r = extractReferences(blocks);
    expect(r.urls.length).toBe(1);
  });

  it("skips URLs from tool_result blocks", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "tool_result", name: "bash", text: "curl https://api.example.com/health", isError: false },
    ];
    const r = extractReferences(blocks);
    expect(r.urls).toEqual([]);
  });

  it("skips URLs from tool_call blocks", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "tool_call", name: "bash", args: { command: "curl https://example.com" } },
    ];
    const r = extractReferences(blocks);
    expect(r.urls).toEqual([]);
  });

  it("extracts both URL and GitHub ref from full GitHub URL", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "See https://github.com/buihongduc132/pi-vcc/issues/42" },
    ];
    const r = extractReferences(blocks);
    expect(r.urls.length).toBeGreaterThan(0);
    expect(r.githubRefs.some(g => g.includes("buihongduc132/pi-vcc#42"))).toBe(true);
  });

  it("rejects owner/repo with common dir owners like src/components", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "Import from src/components/Button" },
    ];
    const r = extractReferences(blocks);
    expect(r.githubRefs).toEqual([]);
  });

  it("rejects IP octets as versions", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "Server at 192.168.1.100" },
    ];
    const r = extractReferences(blocks);
    expect(r.versions).toEqual([]);
  });

  it("extracts version with v prefix", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "Upgrade to v2.3.1 of the SDK" },
    ];
    const r = extractReferences(blocks);
    expect(r.versions).toContain("v2.3.1");
  });

  it("extracts version without v prefix", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "Package version is 0.3.12" },
    ];
    const r = extractReferences(blocks);
    expect(r.versions).toContain("0.3.12");
  });

  it("extracts branch with prefix", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "On branch feat/new-auth-module" },
    ];
    const r = extractReferences(blocks);
    expect(r.branches).toContain("feat/new-auth-module");
  });

  it("extracts commit ref with hex", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "Fixed in commit abc1234def" },
    ];
    const r = extractReferences(blocks);
    expect(r.commitRefs.length).toBeGreaterThan(0);
  });

  it("rejects pure decimal commit refs", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "Issue with number 1234567" },
    ];
    const r = extractReferences(blocks);
    expect(r.commitRefs).toEqual([]);
  });

  it("respects URL cap at 10", () => {
    const blocks: NormalizedBlock[] = Array.from({ length: 15 }, (_, i) => ({
      kind: "user" as const,
      text: `Check https://example${i}.com`,
    }));
    const r = extractReferences(blocks);
    expect(r.urls.length).toBeLessThanOrEqual(10);
  });

  it("formatReferences returns empty for empty extract", () => {
    expect(formatReferences({ urls: [], githubRefs: [], versions: [], branches: [], commitRefs: [] })).toEqual([]);
  });

  it("formatReferences joins all categories", () => {
    const r = formatReferences({
      urls: ["https://example.com"],
      githubRefs: ["#42"],
      versions: ["v1.0.0"],
      branches: ["feat/x"],
      commitRefs: ["abc1234"],
    });
    expect(r.length).toBe(5);
    expect(r[0]).toContain("URL:");
    expect(r[1]).toContain("GitHub:");
    expect(r[2]).toContain("Version:");
    expect(r[3]).toContain("Branch:");
    expect(r[4]).toContain("CommitRef:");
  });
});

// ═══════════════════════════════════════════════════════════════
// Edge cases for signals extractor
// ═══════════════════════════════════════════════════════════════

describe("signals edge cases", () => {
  it("does not match constraint at end of question", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "What if we cannot deploy today?" },
    ];
    const s = extractSignals(blocks);
    expect(s.constraints).toEqual([]);
  });

  it("does not match very short lines", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "do not" },
    ];
    const s = extractSignals(blocks);
    expect(s.constraints).toEqual([]);
  });

  it("does not match signals from tool_result", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "tool_result", name: "bash", text: "DONE: all tests pass", isError: false },
    ];
    const s = extractSignals(blocks);
    expect(s.statuses).toEqual([]);
  });

  it("does not match signals from tool_call", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "tool_call", name: "bash", args: { command: "echo 'must not do this'" } },
    ];
    const s = extractSignals(blocks);
    expect(s.constraints).toEqual([]);
  });

  it("does not match decision from assistant", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "assistant", text: "I decided to use the simpler approach" },
    ];
    const s = extractSignals(blocks);
    expect(s.decisions).toEqual([]);
  });

  it("matches status DONE from assistant", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "assistant", text: "DONE — auth module migrated successfully" },
    ];
    const s = extractSignals(blocks);
    expect(s.statuses.length).toBe(1);
    expect(s.statuses[0]).toContain("DONE");
  });

  it("deduplicates signals case-insensitively", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "Must Not Push To Main Directly" },
      { kind: "user", text: "must not push to main directly" },
    ];
    const s = extractSignals(blocks);
    expect(s.constraints.length).toBe(1);
  });

  it("clips long constraint lines to 200 chars", () => {
    const long = "must not " + "a".repeat(300);
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: long },
    ];
    const s = extractSignals(blocks);
    expect(s.constraints.length).toBe(1);
    expect(s.constraints[0].length).toBeLessThanOrEqual(200);
  });

  it("respects constraint cap at 5", () => {
    const blocks: NormalizedBlock[] = Array.from({ length: 8 }, (_, i) => ({
      kind: "user" as const,
      text: `Constraint ${i}: must not do thing number ${i}`,
    }));
    const s = extractSignals(blocks);
    expect(s.constraints.length).toBeLessThanOrEqual(5);
  });

  it("formatSignals returns empty for empty extract", () => {
    expect(formatSignals({ constraints: [], decisions: [], statuses: [] })).toEqual([]);
  });

  it("skips very long lines (>500 chars, likely code dumps)", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "must not " + "x".repeat(600) },
    ];
    const s = extractSignals(blocks);
    expect(s.constraints).toEqual([]);
  });

  it("matches 'off limits' variant", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "The admin panel is off limits for this sprint" },
    ];
    const s = extractSignals(blocks);
    expect(s.constraints.length).toBe(1);
  });

  it("matches 'off-limits' hyphenated variant", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "The admin panel is off-limits for this sprint" },
    ];
    const s = extractSignals(blocks);
    expect(s.constraints.length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// Full pipeline integration tests
// ═══════════════════════════════════════════════════════════════

describe("full pipeline integration", () => {
  it("buildSections includes references and keySignals", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "Fix https://docs.example.com and don't use SQLite" },
      { kind: "assistant", text: "DONE — investigation complete" },
    ];
    const r = buildSections({ blocks });
    expect(r.references.length).toBeGreaterThan(0);
    expect(r.keySignals.length).toBeGreaterThan(0);
  });

  it("buildSections returns empty new sections when no matches", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "Fix the login bug" },
    ];
    const r = buildSections({ blocks });
    // No URLs, no signals — should be empty
    expect(r.references).toEqual([]);
    expect(r.keySignals).toEqual([]);
  });

  it("compile produces valid output with new sections", () => {
    const result = compile({
      messages: [
        { role: "user", content: "Check https://example.com and fix issue #42. Must not break backward compat." },
        { role: "assistant", content: "DONE — analysis complete" },
      ],
    });
    expect(result).toContain("[References]");
    expect(result).toContain("[Key Signals]");
    expect(result).toContain("https://example.com");
    expect(result).toContain("Constraint:");
  });

  it("compile merges references across compactions", () => {
    const prev = compile({
      messages: [
        { role: "user", content: "See https://docs.example.com" },
      ],
    });
    const fresh = compile({
      messages: [
        { role: "user", content: "Also check https://api.example.com/v2" },
      ],
      previousSummary: prev,
    });
    // Both URLs should be present after merge
    expect(fresh).toContain("https://docs.example.com");
    expect(fresh).toContain("https://api.example.com/v2");
  });

  it("compile merges key signals across compactions", () => {
    const prev = compile({
      messages: [
        { role: "user", content: "Must not push to main directly" },
      ],
    });
    const fresh = compile({
      messages: [
        { role: "user", content: "Decided to use Redis for caching" },
      ],
      previousSummary: prev,
    });
    expect(fresh).toContain("Constraint:");
    expect(fresh).toContain("Decision:");
  });

  it("backwards compat: output identical when new sections empty", () => {
    const result = compile({
      messages: [
        { role: "user", content: "Fix the login bug" },
        { role: "assistant", content: "I'll fix it." },
      ],
    });
    // Should have standard sections
    expect(result).toContain("[Session Goal]");
    // New sections should NOT appear when empty
    expect(result).not.toContain("[References]");
    expect(result).not.toContain("[Key Signals]");
  });
});
