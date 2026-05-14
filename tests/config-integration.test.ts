import { describe, it, expect } from "bun:test";
import { extractReferences } from "../src/extract/references";
import { extractSignals } from "../src/extract/signals";
import type { NormalizedBlock } from "../src/types";

describe("config integration: references", () => {
  const blocks: NormalizedBlock[] = [
    { kind: "user", text: "Check https://example.com and fix the bug" },
  ];

  it("enabled=false returns empty extract", () => {
    const r = extractReferences(blocks, { enabled: false });
    expect(r.urls).toEqual([]);
    expect(r.githubRefs).toEqual([]);
  });

  it("enabled=undefined (default) extracts normally", () => {
    const r = extractReferences(blocks);
    expect(r.urls.length).toBeGreaterThan(0);
  });

  it("extraUrlPatterns adds custom patterns", () => {
    const customBlocks: NormalizedBlock[] = [
      { kind: "user", text: "See ftp://files.example.com/data for the dataset" },
    ];
    const r = extractReferences(customBlocks, {
      extraUrlPatterns: ["ftp://\\S+"],
    });
    expect(r.urls.some(u => u.startsWith("ftp://"))).toBe(true);
  });

  it("extraGithubRefPatterns adds custom patterns", () => {
    const customBlocks: NormalizedBlock[] = [
      { kind: "user", text: "See JIRA-1234 for the issue details" },
    ];
    const r = extractReferences(customBlocks, {
      extraGithubRefPatterns: ["[A-Z]+-\\d+"],
    });
    expect(r.githubRefs).toContain("JIRA-1234");
  });

  it("extraVersionPatterns adds custom patterns", () => {
    const customBlocks: NormalizedBlock[] = [
      { kind: "user", text: "We need version 2.0-alpha.3 of the package" },
    ];
    const r = extractReferences(customBlocks, {
      extraVersionPatterns: ["\\d+\\.\\d+-[a-z]+\\.\\d+"],
    });
    expect(r.versions.some(v => v.includes("alpha"))).toBe(true);
  });

  it("extraBranchPatterns adds custom patterns", () => {
    const customBlocks: NormalizedBlock[] = [
      { kind: "user", text: "Work on feature/new-dashboard component" },
    ];
    const r = extractReferences(customBlocks, {
      extraBranchPatterns: ["\\bfeature/[\\w-]+"],
    });
    expect(r.branches.some(b => b.includes("feature/"))).toBe(true);
  });
});

describe("config integration: signals", () => {
  it("enabled=false returns empty extract", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "must not push to main directly" },
    ];
    const s = extractSignals(blocks, { enabled: false });
    expect(s.constraints).toEqual([]);
  });

  it("extraConstraintPatterns adds custom constraint keywords", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "this is strictly prohibited in our workflow" },
    ];
    // Without extra pattern: no match
    const s1 = extractSignals(blocks);
    expect(s1.constraints.length).toBe(0);
    // With extra pattern: matches
    const s2 = extractSignals(blocks, {
      extraConstraintPatterns: ["\\bstrictly prohibited\\b"],
    });
    expect(s2.constraints.length).toBe(1);
  });

  it("extraDecisionPatterns adds custom decision keywords", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "opted for the microservices approach because scalability" },
    ];
    const s = extractSignals(blocks, {
      extraDecisionPatterns: ["\\bopted for\\b"],
    });
    expect(s.decisions.length).toBe(1);
    expect(s.decisions[0]).toContain("opted for");
  });

  it("extraStatusKeywords adds custom status markers", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "assistant", text: "REVIEWED: the PR looks good to merge" },
    ];
    const s = extractSignals(blocks, {
      extraStatusKeywords: ["REVIEWED"],
    });
    expect(s.statuses.length).toBe(1);
    expect(s.statuses[0]).toContain("REVIEWED");
  });
});
