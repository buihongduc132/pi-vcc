import { describe, it, expect } from "vitest";
import { formatSummary } from "../src/core/format";
import type { SectionData } from "../src/sections";

const empty: SectionData = {
  sessionGoal: [],
  outstandingContext: [],
  filesAndChanges: [],
  commits: [],
  references: [],
  keySignals: [],
  userPreferences: [],
  briefTranscript: "",
  transcriptEntries: [],
};

describe("formatSummary", () => {
  it("returns empty string for all-empty sections", () => {
    expect(formatSummary(empty)).toBe("");
  });

  it("formats a single header section", () => {
    const data = {
      ...empty,
      sessionGoal: ["fix auth bug"],
    };
    const r = formatSummary(data);
    expect(r).toContain("[Session Goal]");
    expect(r).toContain("- fix auth bug");
  });

  it("separates header and brief transcript with ---", () => {
    const data = {
      ...empty,
      sessionGoal: ["goal"],
      briefTranscript: "[user]\ndo something",
    };
    const r = formatSummary(data);
    expect(r).toContain("[Session Goal]");
    expect(r).toContain("---");
    expect(r).toContain("[user]\ndo something");
  });

  it("renders brief transcript alone when no header sections", () => {
    const data = {
      ...empty,
      briefTranscript: "[user]\nhi\n\n[assistant]\nhello",
    };
    const r = formatSummary(data);
    expect(r).toContain("[user]\nhi\n\n[assistant]\nhello");
  });

  it("joins multiple header sections with blank line", () => {
    const data = {
      ...empty,
      sessionGoal: ["goal"],
      outstandingContext: ["blocker"],
    };
    const r = formatSummary(data);
    expect(r).toContain("[Session Goal]");
    expect(r).toContain("[Outstanding Context]");
    expect(r).toContain("\n\n");
  });

  it("renders References section after Commits", () => {
    const data = {
      ...empty,
      commits: ["abc1234: fix bug"],
      references: ["URL: https://example.com", "GitHub: #42"],
    };
    const r = formatSummary(data);
    expect(r).toContain("[Commits]");
    expect(r).toContain("[References]");
    expect(r).toContain("- URL: https://example.com");
    expect(r).toContain("- GitHub: #42");
    // References should appear after Commits in output
    const commitsIdx = r.indexOf("[Commits]");
    const refsIdx = r.indexOf("[References]");
    expect(refsIdx).toBeGreaterThan(commitsIdx);
  });

  it("skips References section when empty", () => {
    const data = {
      ...empty,
      sessionGoal: ["goal"],
      references: [],
    };
    const r = formatSummary(data);
    expect(r).not.toContain("[References]");
  });
});
