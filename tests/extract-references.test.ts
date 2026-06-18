import { describe, it, expect } from "vitest";
import { extractReferences, formatReferences } from "../src/extract/references";
import type { NormalizedBlock } from "../src/types";

// ── extractReferences ──

describe("extractReferences", () => {
  // ── URLs ──

  it("returns empty for no blocks", () => {
    expect(extractReferences([]).urls).toEqual([]);
    expect(extractReferences([]).githubRefs).toEqual([]);
  });

  it("extracts http URL from user message", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "Check out http://example.com for the docs" },
    ];
    const refs = extractReferences(blocks);
    expect(refs.urls).toContain("http://example.com");
  });

  it("extracts https URL from user message", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "See https://docs.site.com/api/v2#section" },
    ];
    const refs = extractReferences(blocks);
    expect(refs.urls).toContain("https://docs.site.com/api/v2#section");
  });

  it("extracts IP:port URL", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "The server is at http://example.com:4747" },
    ];
    const refs = extractReferences(blocks);
    expect(refs.urls).toContain("http://example.com:4747");
  });

  it("strips trailing punctuation from URLs", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "See https://example.com/docs. And also https://other.com/path," },
    ];
    const refs = extractReferences(blocks);
    expect(refs.urls).toContain("https://example.com/docs");
    expect(refs.urls).toContain("https://other.com/path");
  });

  it("strips trailing closing paren from URLs", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "Check the API (https://api.example.com/v2)" },
    ];
    const refs = extractReferences(blocks);
    expect(refs.urls).toContain("https://api.example.com/v2");
  });

  it("extracts multiple URLs from one message", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "See https://a.com and http://b.com and https://c.com" },
    ];
    const refs = extractReferences(blocks);
    expect(refs.urls).toHaveLength(3);
  });

  it("deduplicates same URL across blocks", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "Use https://example.com" },
      { kind: "assistant", text: "I checked https://example.com" },
    ];
    const refs = extractReferences(blocks);
    expect(refs.urls).toEqual(["https://example.com"]);
  });

  it("extracts URLs from assistant blocks too", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "assistant", text: "The docs are at https://docs.example.com/api" },
    ];
    const refs = extractReferences(blocks);
    expect(refs.urls).toContain("https://docs.example.com/api");
  });

  it("extracts URL from markdown link syntax", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "Check [the docs](https://docs.example.com/guide) for details" },
    ];
    const refs = extractReferences(blocks);
    expect(refs.urls).toContain("https://docs.example.com/guide");
  });

  it("does NOT extract file:// URLs", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "Open file:///path/to/file" },
    ];
    const refs = extractReferences(blocks);
    expect(refs.urls).not.toContain("file:///path/to/file");
    expect(refs.urls).toHaveLength(0);
  });

  it("skips tool_result blocks for URL extraction", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "tool_result", name: "bash", text: "curl https://example.com/api\nResponse: 200 OK", isError: false },
    ];
    const refs = extractReferences(blocks);
    expect(refs.urls).toHaveLength(0);
  });

  it("skips tool_call blocks for URL extraction", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "tool_call", name: "bash", args: { command: "curl https://example.com/api" } },
    ];
    const refs = extractReferences(blocks);
    expect(refs.urls).toHaveLength(0);
  });

  it("caps URLs at 10 entries", () => {
    const urls = Array.from({ length: 15 }, (_, i) => `https://site${i}.com`);
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: urls.join(" ") },
    ];
    const refs = extractReferences(blocks);
    expect(refs.urls).toHaveLength(10);
  });

  // ── GitHub refs ──

  it("extracts bare issue number #42", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "Fix issue #42" },
    ];
    const refs = extractReferences(blocks);
    expect(refs.githubRefs).toContain("#42");
  });

  it("extracts PR reference PR #7", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "Merge PR #7" },
    ];
    const refs = extractReferences(blocks);
    expect(refs.githubRefs).toContain("PR #7");
  });

  it("extracts pr#12 variant (normalized to 'pr #12')", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "Review pr#12 when ready" },
    ];
    const refs = extractReferences(blocks);
    // The PR regex captures 'pr' and '12' separately, joining as 'pr #12'
    expect(refs.githubRefs).toContain("pr #12");
  });

  it("extracts owner/repo path", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "The repo is at buihongduc132/pi-plugins" },
    ];
    const refs = extractReferences(blocks);
    expect(refs.githubRefs).toContain("buihongduc132/pi-plugins");
  });

  it("does NOT match file paths as owner/repo", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "Edit src/components/button.tsx" },
    ];
    const refs = extractReferences(blocks);
    // src/components doesn't look like owner/repo (owner must be alnum with hyphens)
    expect(refs.githubRefs.every(r => !r.startsWith("src/"))).toBe(true);
  });

  it("extracts full GitHub URL as both URL and github ref", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "See https://github.com/owner/repo/issues/42" },
    ];
    const refs = extractReferences(blocks);
    expect(refs.urls).toContain("https://github.com/owner/repo/issues/42");
    expect(refs.githubRefs).toContain("owner/repo#42");
  });

  it("deduplicates github refs", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "Fix #42" },
      { kind: "assistant", text: "Also related to #42" },
    ];
    const refs = extractReferences(blocks);
    expect(refs.githubRefs.filter(r => r === "#42")).toHaveLength(1);
  });

  it("caps github refs at 8 entries", () => {
    const issues = Array.from({ length: 12 }, (_, i) => `#${i + 1}`).join(" ");
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: `Fix ${issues}` },
    ];
    const refs = extractReferences(blocks);
    expect(refs.githubRefs.length).toBeLessThanOrEqual(8);
  });

  // ── Versions ──

  it("extracts v1.2.3 version", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "Upgrade to v1.2.3" },
    ];
    const refs = extractReferences(blocks);
    expect(refs.versions).toContain("v1.2.3");
  });

  it("extracts v0.3.12 version", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "We're at v0.3.12" },
    ];
    const refs = extractReferences(blocks);
    expect(refs.versions).toContain("v0.3.12");
  });

  it("extracts bare semver 2.0.1", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "The version is 2.0.1 now" },
    ];
    const refs = extractReferences(blocks);
    expect(refs.versions).toContain("2.0.1");
  });

  it("does NOT match IP address octets as versions", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "The server is at 192.168.1.100" },
    ];
    const refs = extractReferences(blocks);
    // 192.168.1 is not a version (no v prefix and in IP context), 1.100 not standalone
    expect(refs.versions).toHaveLength(0);
  });

  it("deduplicates versions", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "Using v1.0.0" },
      { kind: "assistant", text: "Confirmed v1.0.0" },
    ];
    const refs = extractReferences(blocks);
    expect(refs.versions).toEqual(["v1.0.0"]);
  });

  it("caps versions at 5 entries", () => {
    const versions = Array.from({ length: 8 }, (_, i) => `v${i}.0.0`).join(", ");
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: `Versions: ${versions}` },
    ];
    const refs = extractReferences(blocks);
    expect(refs.versions.length).toBeLessThanOrEqual(5);
  });

  // ── Branches ──

  it("extracts feat/ branch", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "Work on feat/new-auth module" },
    ];
    const refs = extractReferences(blocks);
    expect(refs.branches).toContain("feat/new-auth");
  });

  it("extracts fix/ branch", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "Check the fix/login-bug branch" },
    ];
    const refs = extractReferences(blocks);
    expect(refs.branches).toContain("fix/login-bug");
  });

  it("extracts hotfix/, release/, chore/, refactor/, docs/ branches", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "Branches: hotfix/urgent-fix, release/v2, chore/cleanup, refactor/api, docs/readme" },
    ];
    const refs = extractReferences(blocks);
    expect(refs.branches).toContain("hotfix/urgent-fix");
    expect(refs.branches).toContain("release/v2");
    expect(refs.branches).toContain("chore/cleanup");
    expect(refs.branches).toContain("refactor/api");
    expect(refs.branches).toContain("docs/readme");
  });

  it("extracts test/ branch", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "Work on test/unit-tests" },
    ];
    const refs = extractReferences(blocks);
    expect(refs.branches).toContain("test/unit-tests");
  });

  it("does NOT extract random word/something as branch", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "Just some/random text" },
    ];
    const refs = extractReferences(blocks);
    expect(refs.branches).toHaveLength(0);
  });

  it("deduplicates branches", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "On feat/new-auth" },
      { kind: "assistant", text: "Checking feat/new-auth" },
    ];
    const refs = extractReferences(blocks);
    expect(refs.branches).toEqual(["feat/new-auth"]);
  });

  it("caps branches at 5 entries", () => {
    const branches = Array.from({ length: 8 }, (_, i) => `feat/feature-${i}`).join(" ");
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: branches },
    ];
    const refs = extractReferences(blocks);
    expect(refs.branches.length).toBeLessThanOrEqual(5);
  });

  // ── Commit refs ──

  it("extracts 7-char hex commit ref", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "This was fixed in abc1234" },
    ];
    const refs = extractReferences(blocks);
    expect(refs.commitRefs).toContain("abc1234");
  });

  it("extracts 12-char hex commit ref", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "See commit abc123456789" },
    ];
    const refs = extractReferences(blocks);
    expect(refs.commitRefs).toContain("abc123456789");
  });

  it("does NOT extract hex from tool_result blocks", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "tool_result", name: "bash", text: "[main abc1234] fix: login bug", isError: false },
    ];
    const refs = extractReferences(blocks);
    expect(refs.commitRefs).toHaveLength(0);
  });

  it("deduplicates commit refs", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "Fixed in abc1234" },
      { kind: "assistant", text: "abc1234 was the fix commit" },
    ];
    const refs = extractReferences(blocks);
    expect(refs.commitRefs).toEqual(["abc1234"]);
  });

  it("caps commit refs at 5 entries", () => {
    const commits = Array.from({ length: 8 }, (_, i) =>
      `abc${i.toString().padStart(4, "0")}`
    ).join(" ");
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: commits },
    ];
    const refs = extractReferences(blocks);
    expect(refs.commitRefs.length).toBeLessThanOrEqual(5);
  });

  // ── General skipping ──

  it("skips thinking blocks", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "thinking", text: "Check https://example.com and #42", redacted: false },
    ];
    const refs = extractReferences(blocks);
    expect(refs.urls).toHaveLength(0);
    expect(refs.githubRefs).toHaveLength(0);
  });

  it("returns all-zeros for empty blocks array", () => {
    const refs = extractReferences([]);
    expect(refs).toEqual({
      urls: [],
      githubRefs: [],
      versions: [],
      branches: [],
      commitRefs: [],
    });
  });
});

// ── formatReferences ──

describe("formatReferences", () => {
  it("returns empty array when no references", () => {
    expect(formatReferences({
      urls: [],
      githubRefs: [],
      versions: [],
      branches: [],
      commitRefs: [],
    })).toEqual([]);
  });

  it("formats URLs with prefix", () => {
    const lines = formatReferences({
      urls: ["https://example.com"],
      githubRefs: [],
      versions: [],
      branches: [],
      commitRefs: [],
    });
    expect(lines).toEqual(["URL: https://example.com"]);
  });

  it("formats GitHub refs with prefix", () => {
    const lines = formatReferences({
      urls: [],
      githubRefs: ["#42", "buihongduc132/pi-plugins"],
      versions: [],
      branches: [],
      commitRefs: [],
    });
    expect(lines).toContain("GitHub: #42, buihongduc132/pi-plugins");
  });

  it("formats versions with prefix", () => {
    const lines = formatReferences({
      urls: [],
      githubRefs: [],
      versions: ["v1.2.3"],
      branches: [],
      commitRefs: [],
    });
    expect(lines).toContain("Version: v1.2.3");
  });

  it("formats branches with prefix", () => {
    const lines = formatReferences({
      urls: [],
      githubRefs: [],
      versions: [],
      branches: ["feat/new-auth"],
      commitRefs: [],
    });
    expect(lines).toContain("Branch: feat/new-auth");
  });

  it("formats commit refs with prefix", () => {
    const lines = formatReferences({
      urls: [],
      githubRefs: [],
      versions: [],
      branches: [],
      commitRefs: ["abc1234"],
    });
    expect(lines).toContain("CommitRef: abc1234");
  });

  it("combines multiple categories", () => {
    const lines = formatReferences({
      urls: ["https://example.com", "https://other.com"],
      githubRefs: ["#42"],
      versions: ["v1.0.0"],
      branches: ["feat/new"],
      commitRefs: ["abc1234"],
    });
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe("URL: https://example.com, https://other.com");
    expect(lines[1]).toBe("GitHub: #42");
    expect(lines[2]).toBe("Version: v1.0.0");
    expect(lines[3]).toBe("Branch: feat/new");
    expect(lines[4]).toBe("CommitRef: abc1234");
  });

  it("skips empty categories entirely", () => {
    const lines = formatReferences({
      urls: ["https://example.com"],
      githubRefs: [],
      versions: [],
      branches: [],
      commitRefs: [],
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe("URL: https://example.com");
  });
});
