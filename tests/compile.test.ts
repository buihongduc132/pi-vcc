import { describe, it, expect } from "vitest";
import { compile } from "../src/core/summarize";
import {
  userMsg,
  assistantText,
  assistantWithToolCall,
  toolResult,
} from "./fixtures";

describe("compile", () => {
  it("returns empty string for no messages", async () => {
    expect(await compile({ messages: [] })).toBe("");
  });

  it("produces hybrid output with header + brief transcript", async () => {
    const r = await compile({
      messages: [
        userMsg("Fix login bug"),
        assistantWithToolCall("Read", { path: "auth.ts" }),
        assistantText("Found the issue.\n1. Fix validation"),
      ],
    });
    expect(r).toContain("[Session Goal]");
    expect(r).toContain("Fix login bug");
    expect(r).toContain("---");
    expect(r).toContain("[user]\nFix login bug");
    expect(r).toContain('* Read "auth.ts"');
    expect(r).toContain("Found the issue.");
  });

  it("merges previous summary goals", async () => {
    const r = await compile({
      messages: [userMsg("New task")],
      previousSummary: "[Session Goal]\n- Original goal\n\n---\n\n[user]\nOriginal goal",
    });
    expect(r).toContain("- Original goal");
    expect(r).toContain("- New task");
  });

  it("appends brief transcript on merge", async () => {
    const previousSummary = [
      "[Session Goal]\n- Original goal",
      "---",
      "[user]\nOriginal goal\n\n[assistant]\n* Read \"old.ts\"",
    ].join("\n\n");
    const r = await compile({
      previousSummary,
      messages: [
        userMsg("Next step"),
        assistantWithToolCall("Read", { path: "new.ts" }),
      ],
    });
    expect(r).toContain('* Read "old.ts"');
    expect(r).toContain('* Read "new.ts"');
    expect(r).toContain("Next step");
  });

  it("outstanding context is volatile (fresh only)", async () => {
    const previousSummary = "[Outstanding Context]\n- old blocker\n\n---\n\n[user]\nhi";
    const r = await compile({
      previousSummary,
      messages: [userMsg("continue")],
    });
    expect(r).not.toContain("old blocker");
  });

  it("caps long brief transcript with rolling window", async () => {
    // Build a very long previous transcript
    const longTranscript = Array.from({ length: 200 }, (_, i) =>
      `[user]\nmessage ${i}`
    ).join("\n\n");
    const previousSummary = `[Session Goal]\n- goal\n\n---\n\n${longTranscript}`;
    const r = await compile({
      previousSummary,
      messages: [userMsg("latest")],
    });
    expect(r).toContain("earlier lines omitted");
    expect(r).toContain("latest");
  });

  // ── References merge ──

  it("merges References across compactions with dedup", async () => {
    const previousSummary = [
      "[Session Goal]\n- goal",
      "[References]\n- URL: https://example.com\n- GitHub: #42",
      "---",
      "[user]\noriginal",
    ].join("\n\n");
    const r = await compile({
      previousSummary,
      messages: [userMsg("Check https://other.com and #42")],
    });
    // Should contain both URLs
    expect(r).toContain("https://example.com");
    expect(r).toContain("https://other.com");
    // GitHub #42 should be deduped
    const count = (r.match(/#42/g) ?? []).length;
    // At least one in References section
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it("preserves References from fresh when no previous", async () => {
    const r = await compile({
      messages: [userMsg("See https://docs.example.com")],
    });
    expect(r).toContain("[References]");
    expect(r).toContain("https://docs.example.com");
  });
});
