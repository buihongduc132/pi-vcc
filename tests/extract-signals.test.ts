import { describe, it, expect } from "vitest";
import { extractSignals, formatSignals } from "../src/extract/signals";
import type { NormalizedBlock } from "../src/types";

// ─── extractSignals ────────────────────────────────────────────────

describe("extractSignals", () => {
  // ── empty / no-match basics ──────────────────────────────────────

  it("returns empty for no blocks", () => {
    const s = extractSignals([]);
    expect(s.constraints).toEqual([]);
    expect(s.decisions).toEqual([]);
    expect(s.statuses).toEqual([]);
  });

  it("returns empty when no user or assistant blocks", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "tool_call", name: "bash", args: { command: "ls" } },
      { kind: "tool_result", name: "bash", text: "file.ts", isError: false },
      { kind: "thinking", text: "hmm", redacted: false },
    ];
    const s = extractSignals(blocks);
    expect(s.constraints).toEqual([]);
    expect(s.decisions).toEqual([]);
    expect(s.statuses).toEqual([]);
  });

  // ── Constraints ──────────────────────────────────────────────────

  describe("constraints", () => {
    it("captures 'must not' constraint", () => {
      const blocks: NormalizedBlock[] = [
        { kind: "user", text: "You must not push to main directly" },
      ];
      const s = extractSignals(blocks);
      expect(s.constraints.length).toBe(1);
      expect(s.constraints[0]).toContain("must not push to main directly");
    });

    it("captures 'don't' constraint", () => {
      const blocks: NormalizedBlock[] = [
        { kind: "user", text: "Don't use any external dependencies" },
      ];
      const s = extractSignals(blocks);
      expect(s.constraints.length).toBe(1);
      expect(s.constraints[0]).toContain("Don't use any external dependencies");
    });

    it("captures 'do not' constraint", () => {
      const blocks: NormalizedBlock[] = [
        { kind: "user", text: "Do not commit to main branch" },
      ];
      const s = extractSignals(blocks);
      expect(s.constraints.length).toBe(1);
      expect(s.constraints[0]).toContain("Do not commit to main");
    });

    it("captures 'cannot' constraint", () => {
      const blocks: NormalizedBlock[] = [
        { kind: "user", text: "We cannot modify the public API" },
      ];
      const s = extractSignals(blocks);
      expect(s.constraints.length).toBe(1);
      expect(s.constraints[0]).toContain("cannot modify the public API");
    });

    it("captures 'forbidden' constraint", () => {
      const blocks: NormalizedBlock[] = [
        { kind: "user", text: "It is forbidden to write to /etc/config" },
      ];
      const s = extractSignals(blocks);
      expect(s.constraints.length).toBe(1);
      expect(s.constraints[0]).toContain("forbidden");
    });

    it("captures 'disallowed' constraint", () => {
      const blocks: NormalizedBlock[] = [
        { kind: "user", text: "Direct DB access is disallowed in production" },
      ];
      const s = extractSignals(blocks);
      expect(s.constraints.length).toBe(1);
      expect(s.constraints[0]).toContain("disallowed");
    });

    it("captures 'off-limits' constraint", () => {
      const blocks: NormalizedBlock[] = [
        { kind: "user", text: "The payment module is off-limits for now" },
      ];
      const s = extractSignals(blocks);
      expect(s.constraints.length).toBe(1);
      expect(s.constraints[0]).toContain("off-limits");
    });

    it("captures 'off limits' constraint (space variant)", () => {
      const blocks: NormalizedBlock[] = [
        { kind: "user", text: "That service is off limits for this sprint" },
      ];
      const s = extractSignals(blocks);
      expect(s.constraints.length).toBe(1);
      expect(s.constraints[0]).toContain("off limits");
    });

    it("captures 'out of scope' constraint", () => {
      const blocks: NormalizedBlock[] = [
        { kind: "user", text: "The admin panel is out of scope for this release" },
      ];
      const s = extractSignals(blocks);
      expect(s.constraints.length).toBe(1);
      expect(s.constraints[0]).toContain("out of scope");
    });

    it("captures 'excluded' constraint", () => {
      const blocks: NormalizedBlock[] = [
        { kind: "user", text: "Mobile views are excluded from this release" },
      ];
      const s = extractSignals(blocks);
      expect(s.constraints.length).toBe(1);
      expect(s.constraints[0]).toContain("excluded");
    });

    it("ignores constraint-like lines in tool_result blocks", () => {
      const blocks: NormalizedBlock[] = [
        { kind: "tool_result", name: "bash", text: "Error: cannot write to /etc", isError: true },
      ];
      const s = extractSignals(blocks);
      expect(s.constraints).toEqual([]);
    });

    it("ignores constraint-like lines in tool_call blocks", () => {
      const blocks: NormalizedBlock[] = [
        { kind: "tool_call", name: "bash", args: { command: "echo 'do not touch this'" } },
      ];
      const s = extractSignals(blocks);
      expect(s.constraints).toEqual([]);
    });

    it("ignores constraint-like lines in assistant blocks", () => {
      const blocks: NormalizedBlock[] = [
        { kind: "assistant", text: "I understand that we must not push to main" },
      ];
      const s = extractSignals(blocks);
      // constraints only from user blocks
      expect(s.constraints).toEqual([]);
    });

    it("rejects constraint lines shorter than 15 chars", () => {
      const blocks: NormalizedBlock[] = [
        { kind: "user", text: "do not do it" },
      ];
      const s = extractSignals(blocks);
      expect(s.constraints).toEqual([]);
    });

    it("rejects constraint lines that are questions", () => {
      const blocks: NormalizedBlock[] = [
        { kind: "user", text: "Should we do not modify this file?" },
      ];
      const s = extractSignals(blocks);
      expect(s.constraints).toEqual([]);
    });
  });

  // ── Decisions ────────────────────────────────────────────────────

  describe("decisions", () => {
    it("captures 'decided' decision", () => {
      const blocks: NormalizedBlock[] = [
        { kind: "user", text: "We decided to use Redis for caching" },
      ];
      const s = extractSignals(blocks);
      expect(s.decisions.length).toBe(1);
      expect(s.decisions[0]).toContain("decided to use Redis");
    });

    it("captures \"let's use\" decision", () => {
      const blocks: NormalizedBlock[] = [
        { kind: "user", text: "Let's use approach B for the API layer" },
      ];
      const s = extractSignals(blocks);
      expect(s.decisions.length).toBe(1);
      expect(s.decisions[0]).toContain("use approach B");
    });

    it("captures 'going with' decision", () => {
      const blocks: NormalizedBlock[] = [
        { kind: "user", text: "Going with the microservice pattern for scaling" },
      ];
      const s = extractSignals(blocks);
      expect(s.decisions.length).toBe(1);
      expect(s.decisions[0]).toContain("Going with the microservice");
    });

    it("captures 'chose' decision", () => {
      const blocks: NormalizedBlock[] = [
        { kind: "user", text: "We chose SQLite for simplicity in this module" },
      ];
      const s = extractSignals(blocks);
      expect(s.decisions.length).toBe(1);
      expect(s.decisions[0]).toContain("chose SQLite");
    });

    it("captures \"we'll use\" decision", () => {
      const blocks: NormalizedBlock[] = [
        { kind: "user", text: "We'll use bun instead of node for this project" },
      ];
      const s = extractSignals(blocks);
      expect(s.decisions.length).toBe(1);
      expect(s.decisions[0]).toContain("use bun instead");
    });

    it("ignores decisions in tool_result blocks", () => {
      const blocks: NormalizedBlock[] = [
        { kind: "tool_result", name: "bash", text: "decided to use redis", isError: false },
      ];
      const s = extractSignals(blocks);
      expect(s.decisions).toEqual([]);
    });

    it("ignores decisions in assistant blocks", () => {
      const blocks: NormalizedBlock[] = [
        { kind: "assistant", text: "I decided to refactor the module" },
      ];
      const s = extractSignals(blocks);
      // decisions only from user blocks
      expect(s.decisions).toEqual([]);
    });

    it("rejects decision lines shorter than 15 chars", () => {
      const blocks: NormalizedBlock[] = [
        { kind: "user", text: "chose Redis" },
      ];
      const s = extractSignals(blocks);
      expect(s.decisions).toEqual([]);
    });

    it("rejects decision lines that are questions", () => {
      const blocks: NormalizedBlock[] = [
        { kind: "user", text: "Should we decided to use Redis here?" },
      ];
      const s = extractSignals(blocks);
      expect(s.decisions).toEqual([]);
    });
  });

  // ── Status markers ───────────────────────────────────────────────

  describe("statuses", () => {
    it("captures DONE status from user block", () => {
      const blocks: NormalizedBlock[] = [
        { kind: "user", text: "DONE — auth module migrated successfully" },
      ];
      const s = extractSignals(blocks);
      expect(s.statuses.length).toBe(1);
      expect(s.statuses[0]).toContain("DONE");
    });

    it("captures DONE status from assistant block", () => {
      const blocks: NormalizedBlock[] = [
        { kind: "assistant", text: "DONE — all tests passing now" },
      ];
      const s = extractSignals(blocks);
      expect(s.statuses.length).toBe(1);
      expect(s.statuses[0]).toContain("DONE");
    });

    it("captures TODO status", () => {
      const blocks: NormalizedBlock[] = [
        { kind: "user", text: "TODO: add integration tests for the auth flow" },
      ];
      const s = extractSignals(blocks);
      expect(s.statuses.length).toBe(1);
      expect(s.statuses[0]).toContain("TODO");
    });

    it("captures WIP status", () => {
      const blocks: NormalizedBlock[] = [
        { kind: "user", text: "WIP: still debugging the login issue" },
      ];
      const s = extractSignals(blocks);
      expect(s.statuses.length).toBe(1);
      expect(s.statuses[0]).toContain("WIP");
    });

    it("captures 'blocked' status", () => {
      const blocks: NormalizedBlock[] = [
        { kind: "user", text: "Blocked on upstream fix for the auth library" },
      ];
      const s = extractSignals(blocks);
      expect(s.statuses.length).toBe(1);
      expect(s.statuses[0]).toContain("Blocked");
    });

    it("captures 'resolved' status", () => {
      const blocks: NormalizedBlock[] = [
        { kind: "user", text: "Resolved: was a typo in the config file" },
      ];
      const s = extractSignals(blocks);
      expect(s.statuses.length).toBe(1);
      expect(s.statuses[0]).toContain("Resolved");
    });

    it("ignores status-like lines in tool_result blocks", () => {
      const blocks: NormalizedBlock[] = [
        { kind: "tool_result", name: "bash", text: "DONE: all files processed", isError: false },
      ];
      const s = extractSignals(blocks);
      expect(s.statuses).toEqual([]);
    });

    it("ignores status-like lines in tool_call blocks", () => {
      const blocks: NormalizedBlock[] = [
        { kind: "tool_call", name: "bash", args: { command: "echo TODO: fix" } },
      ];
      const s = extractSignals(blocks);
      expect(s.statuses).toEqual([]);
    });

    it("rejects status lines shorter than 15 chars", () => {
      const blocks: NormalizedBlock[] = [
        { kind: "user", text: "DONE" },
      ];
      const s = extractSignals(blocks);
      expect(s.statuses).toEqual([]);
    });

    it("requires status marker to be prominent (start of line or after punctuation)", () => {
      // Status buried mid-sentence should not match
      const blocks: NormalizedBlock[] = [
        { kind: "user", text: "The function returns DONE when the process finishes" },
      ];
      const s = extractSignals(blocks);
      // "DONE" buried mid-sentence — should NOT match
      expect(s.statuses).toEqual([]);
    });

    it("matches status at start of line", () => {
      const blocks: NormalizedBlock[] = [
        { kind: "user", text: "DONE migrating the database" },
      ];
      const s = extractSignals(blocks);
      expect(s.statuses.length).toBe(1);
    });

    it("matches status after punctuation", () => {
      const blocks: NormalizedBlock[] = [
        { kind: "user", text: "Step 3 complete. DONE — the migration is finished" },
      ];
      const s = extractSignals(blocks);
      expect(s.statuses.length).toBe(1);
    });
  });

  // ── Dedup ────────────────────────────────────────────────────────

  describe("deduplication", () => {
    it("deduplicates identical constraints across blocks (case-insensitive)", () => {
      const blocks: NormalizedBlock[] = [
        { kind: "user", text: "Must not push to main directly" },
        { kind: "assistant", text: "ok" },
        { kind: "user", text: "must not push to main directly" },
      ];
      const s = extractSignals(blocks);
      expect(s.constraints.length).toBe(1);
    });

    it("deduplicates identical decisions across blocks (case-insensitive)", () => {
      const blocks: NormalizedBlock[] = [
        { kind: "user", text: "Decided to use Redis for caching" },
        { kind: "assistant", text: "ok" },
        { kind: "user", text: "decided to use redis for caching" },
      ];
      const s = extractSignals(blocks);
      expect(s.decisions.length).toBe(1);
    });

    it("deduplicates identical statuses across blocks (case-insensitive)", () => {
      const blocks: NormalizedBlock[] = [
        { kind: "user", text: "DONE — auth migrated" },
        { kind: "assistant", text: "done — auth migrated" },
      ];
      const s = extractSignals(blocks);
      expect(s.statuses.length).toBe(1);
    });
  });

  // ── Caps ─────────────────────────────────────────────────────────

  describe("caps", () => {
    it("caps constraints at 5", () => {
      const blocks: NormalizedBlock[] = Array.from({ length: 8 }, (_, i) => ({
        kind: "user" as const,
        text: `You must not do thing ${i} in the codebase at all`,
      }));
      const s = extractSignals(blocks);
      expect(s.constraints.length).toBe(5);
    });

    it("caps decisions at 5", () => {
      const blocks: NormalizedBlock[] = Array.from({ length: 8 }, (_, i) => ({
        kind: "user" as const,
        text: `We decided to use library ${i} for the backend implementation`,
      }));
      const s = extractSignals(blocks);
      expect(s.decisions.length).toBe(5);
    });

    it("caps statuses at 5", () => {
      const blocks: NormalizedBlock[] = Array.from({ length: 8 }, (_, i) => ({
        kind: "user" as const,
        text: `DONE — task ${i} completed and verified`,
      }));
      const s = extractSignals(blocks);
      expect(s.statuses.length).toBe(5);
    });
  });

  // ── Clip long lines ──────────────────────────────────────────────

  describe("long lines", () => {
    it("clips constraints longer than 200 chars", () => {
      const longText = "Must not " + "a".repeat(250);
      const blocks: NormalizedBlock[] = [
        { kind: "user", text: longText },
      ];
      const s = extractSignals(blocks);
      expect(s.constraints.length).toBe(1);
      expect(s.constraints[0].length).toBeLessThanOrEqual(200);
    });

    it("clips decisions longer than 200 chars", () => {
      const longText = "Decided " + "b".repeat(250);
      const blocks: NormalizedBlock[] = [
        { kind: "user", text: longText },
      ];
      const s = extractSignals(blocks);
      expect(s.decisions.length).toBe(1);
      expect(s.decisions[0].length).toBeLessThanOrEqual(200);
    });

    it("clips statuses longer than 200 chars", () => {
      const longText = "DONE " + "c".repeat(250);
      const blocks: NormalizedBlock[] = [
        { kind: "user", text: longText },
      ];
      const s = extractSignals(blocks);
      expect(s.statuses.length).toBe(1);
      expect(s.statuses[0].length).toBeLessThanOrEqual(200);
    });
  });

  // ── Multi-line blocks ────────────────────────────────────────────

  describe("multi-line blocks", () => {
    it("extracts multiple constraints from one block", () => {
      const blocks: NormalizedBlock[] = [
        {
          kind: "user",
          text: "You must not push to main directly\nAlso do not modify the release scripts",
        },
      ];
      const s = extractSignals(blocks);
      expect(s.constraints.length).toBe(2);
    });

    it("extracts constraint and decision from same block", () => {
      const blocks: NormalizedBlock[] = [
        {
          kind: "user",
          text: "We decided to use bun for runtime\nMust not use node under any circumstances",
        },
      ];
      const s = extractSignals(blocks);
      expect(s.decisions.length).toBe(1);
      expect(s.constraints.length).toBe(1);
    });
  });

  // ── Negative cases ───────────────────────────────────────────────

  describe("negatives", () => {
    it("does not extract signals from thinking blocks", () => {
      const blocks: NormalizedBlock[] = [
        { kind: "thinking", text: "I must not forget to check the types", redacted: false },
      ];
      const s = extractSignals(blocks);
      expect(s.constraints).toEqual([]);
    });

    it("does not match constraint in question form", () => {
      const blocks: NormalizedBlock[] = [
        { kind: "user", text: "What if we must not push to main?" },
      ];
      const s = extractSignals(blocks);
      expect(s.constraints).toEqual([]);
    });

    it("does not match short hypothetical", () => {
      const blocks: NormalizedBlock[] = [
        { kind: "user", text: "do not?" },
      ];
      const s = extractSignals(blocks);
      expect(s.constraints).toEqual([]);
    });
  });
});

// ─── formatSignals ─────────────────────────────────────────────────

describe("formatSignals", () => {
  it("returns empty array for empty signals", () => {
    expect(formatSignals({ constraints: [], decisions: [], statuses: [] })).toEqual([]);
  });

  it("formats constraints with prefix", () => {
    const result = formatSignals({
      constraints: ["must not push to main"],
      decisions: [],
      statuses: [],
    });
    expect(result).toEqual(["Constraint: must not push to main"]);
  });

  it("formats decisions with prefix", () => {
    const result = formatSignals({
      constraints: [],
      decisions: ["decided to use Redis"],
      statuses: [],
    });
    expect(result).toEqual(["Decision: decided to use Redis"]);
  });

  it("formats statuses with prefix", () => {
    const result = formatSignals({
      constraints: [],
      decisions: [],
      statuses: ["DONE — auth migrated"],
    });
    expect(result).toEqual(["Status: DONE — auth migrated"]);
  });

  it("orders: constraints first, then decisions, then statuses", () => {
    const result = formatSignals({
      constraints: ["must not push"],
      decisions: ["decided to use Redis"],
      statuses: ["DONE — auth migrated"],
    });
    expect(result[0]).toContain("Constraint:");
    expect(result[1]).toContain("Decision:");
    expect(result[2]).toContain("Status:");
  });

  it("returns empty when all arrays empty", () => {
    const result = formatSignals({
      constraints: [],
      decisions: [],
      statuses: [],
    });
    expect(result).toEqual([]);
  });
});
