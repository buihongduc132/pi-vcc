import { describe, it, expect } from "vitest";
import {
  collapseSkillLines,
  collapseSkillText,
} from "../src/core/skill-collapse";
import { compile } from "../src/core/summarize";
import { assistantWithToolCall, userMsg } from "./fixtures";

// ═══════════════════════════════════════════════════════════════
// Branch coverage for src/core/skill-collapse.ts
// Target uncovered lines: 15-21 (skill open + dedup), 24-25 (inside-skill skip + close)
// ═══════════════════════════════════════════════════════════════

describe("collapseSkillLines — branch coverage", () => {
  it("collapses a single skill block and drops all inner content until close tag", () => {
    // Covers: SKILL_TAG_RE match (line 13→14), insideSkill=true (line 15),
    // first-seen push (line 17 true, line 19), close-tag detection (line 24 true),
    // and insideSkill non-close skip (line 24 false → continue, line 25).
    const lines = [
      '<skill name="deploy">',
      "inner content one",
      "inner content two",
      "inner content three",
      "</skill>",
      "regular line after block",
    ];
    expect(collapseSkillLines(lines)).toEqual([
      "[skill: deploy]",
      "regular line after block",
    ]);
  });

  it("skips pushing duplicate skill names (seenSkills dedup branch)", () => {
    // Covers: line 17 false branch — name already in seenSkills, push skipped.
    const lines = [
      '<skill name="a">',
      "content-a-1",
      "</skill>",
      '<skill name="a">',
      "content-a-2",
      "</skill>",
      '<skill name="b">',
      "content-b",
      "</skill>",
    ];
    expect(collapseSkillLines(lines)).toEqual(["[skill: a]", "[skill: b]"]);
  });

  it("passes through ordinary lines unchanged when no skill block is open", () => {
    // Covers: insideSkill=false path → line 27 result.push(line).
    expect(collapseSkillLines(["plain", "another", ""])).toEqual([
      "plain",
      "another",
      "",
    ]);
  });

  it("handles skill tags with leading dash/whitespace prefix", () => {
    // Covers: SKILL_TAG_RE and SKILL_CLOSE_RE optional `-?` and `\s*` prefixes.
    const lines = [
      '- <skill name="dashed">',
      "inner",
      "- </skill>",
      "after",
    ];
    expect(collapseSkillLines(lines)).toEqual(["[skill: dashed]", "after"]);
  });

  it("parses skill name with extra attributes on the open tag", () => {
    // Covers: SKILL_TAG_RE name capture with trailing attrs (no `>` required by regex).
    const lines = [
      '<skill name="with-attrs" type="x" version="2">',
      "x",
      "</skill>",
    ];
    expect(collapseSkillLines(lines)).toEqual(["[skill: with-attrs]"]);
  });

  it("returns empty array for empty input (loop never enters)", () => {
    // Covers: for-of over empty array, all branches untaken.
    expect(collapseSkillLines([])).toEqual([]);
  });
});

describe("collapseSkillText — branch coverage", () => {
  it("collapses a closed skill block with attributes in raw text", () => {
    // Covers: SKILL_BLOCK_RE with `</skill>` terminator and `[^>]*` attrs.
    const text =
      'before\n<skill name="foo" type="x">\ninner\n</skill>\nafter';
    expect(collapseSkillText(text)).toBe("before\n[skill: foo]\nafter");
  });

  it("collapses an unclosed skill block at EOF (the |$ terminator branch)", () => {
    // Covers: SKILL_BLOCK_RE `(?:</skill>|$)` — EOF fallback when no close tag.
    const text = '<skill name="unclosed">stuff that never closes';
    expect(collapseSkillText(text)).toBe("[skill: unclosed]");
  });

  it("collapses multiple distinct skill blocks in one string", () => {
    // Covers: global regex iteration across multiple matches.
    const text =
      '<skill name="a">x</skill> mid <skill name="b">y</skill>';
    expect(collapseSkillText(text)).toBe("[skill: a] mid [skill: b]");
  });

  it("leaves text without any skill tags unchanged", () => {
    // Covers: no-match path — replace returns input as-is.
    expect(collapseSkillText("hello world no skills")).toBe(
      "hello world no skills",
    );
  });

  it("handles empty string input", () => {
    expect(collapseSkillText("")).toBe("");
  });
});

// ═══════════════════════════════════════════════════════════════
// Branch coverage for src/core/summarize.ts
// Target uncovered lines: 52 (Files And Changes merge call),
//   68-103 (entire mergeFileLines function body).
// mergeFileLines / mergeHeaderSection are NOT exported, so they are
// driven through the public compile() with crafted previousSummary strings.
// ═══════════════════════════════════════════════════════════════

describe("compile — Files And Changes merge (mergeFileLines branch coverage)", () => {
  it("merges Modified file lists from previous and fresh (line 52 + happy path)", async () => {
    // Covers: summarize.ts line 52 (return mergeFileLines(prev, fresh)),
    // the parse loop (73-87), cap() <= limit branch (line 94),
    // and Modified emit branch true / Created+Read emit branches false (99-101).
    const previousSummary = "[Files And Changes]\n- Modified: old.ts";
    const r = await compile({
      previousSummary,
      messages: [
        userMsg("edit a file"),
        assistantWithToolCall("Edit", { file_path: "new.ts" }),
      ],
    });
    expect(r).toContain("[Files And Changes]");
    expect(r).toContain("old.ts");
    expect(r).toContain("new.ts");
    // Only Modified category present → Created/Read lines absent.
    expect(r).not.toContain("- Created:");
    expect(r).not.toContain("- Read:");
  });

  it("preserves previous Files And Changes when fresh has none (line 48 !fresh branch)", async () => {
    // Covers: mergeHeaderSection `if (!fresh) return prev;` for the
    // Files And Changes header (fresh has no file ops).
    const previousSummary = "[Files And Changes]\n- Modified: keep.ts";
    const r = await compile({
      previousSummary,
      messages: [userMsg("no file operations in this turn")],
    });
    expect(r).toContain("[Files And Changes]");
    expect(r).toContain("keep.ts");
  });

  it("merges Created category carried in from a legacy previous summary", async () => {
    // Covers: mergeFileLines Created emit branch (line 100 true).
    // Fresh (compile) never emits Created after its own Modified/Created dedup,
    // so the Created entry can only originate from prev here.
    const previousSummary = "[Files And Changes]\n- Created: legacy.ts";
    const r = await compile({
      previousSummary,
      messages: [userMsg("just a task")],
    });
    expect(r).toContain("[Files And Changes]");
    expect(r).toContain("Created: legacy.ts");
  });

  it("merges Read category from previous with Read from fresh tool calls", async () => {
    // Covers: mergeFileLines Read emit branch (line 101 true) and
    // Read category parsing from both prev and fresh.
    const previousSummary = "[Files And Changes]\n- Read: old-read.ts";
    const r = await compile({
      previousSummary,
      messages: [
        userMsg("read some files"),
        assistantWithToolCall("Read", { file_path: "fresh-read.ts" }),
      ],
    });
    expect(r).toContain("[Files And Changes]");
    expect(r).toContain("Read:");
    expect(r).toContain("old-read.ts");
    expect(r).toContain("fresh-read.ts");
  });

  it("strips (+N more) suffix when re-merging file lists (line 80 regex)", async () => {
    // Covers: mergeFileLines line 80 — rest.replace(/\s*\(\+\d+ more\)\s*$/, "").
    const previousSummary =
      "[Files And Changes]\n- Modified: a.ts (+5 more)";
    const r = await compile({
      previousSummary,
      messages: [
        userMsg("edit"),
        assistantWithToolCall("Edit", { file_path: "b.ts" }),
      ],
    });
    // The legacy "(+5 more)" must be stripped; with only 2 real entries no new cap applies.
    expect(r).not.toContain("(+5 more)");
    expect(r).toContain("a.ts");
    expect(r).toContain("b.ts");
  });

  it("skips empty comma-separated entries when parsing file lists (line 83 false)", async () => {
    // Covers: mergeFileLines line 83 false branch — trimmed === "" → not added.
    // Fresh must contribute a real Files And Changes section (here via a Read tool
    // call) so mergeHeaderSection's `!fresh` guard doesn't short-circuit and
    // mergeFileLines actually runs over prev's `a.ts, , b.ts` list.
    const previousSummary =
      "[Files And Changes]\n- Modified: a.ts, , b.ts";
    const r = await compile({
      previousSummary,
      messages: [
        userMsg("read something"),
        assistantWithToolCall("Read", { file_path: "fresh.ts" }),
      ],
    });
    expect(r).toContain("a.ts");
    expect(r).toContain("b.ts");
  });

  it("drops Created entry when the same path is also in Modified (line 90 dedup)", async () => {
    // Covers: mergeFileLines line 90 — for (const p of merged.Modified) merged.Created.delete(p).
    // Prev carries Created: shared.ts; fresh Edit adds shared.ts to Modified →
    // cross-dedup removes shared.ts from Created.
    const previousSummary = "[Files And Changes]\n- Created: shared.ts";
    const r = await compile({
      previousSummary,
      messages: [
        userMsg("edit shared"),
        assistantWithToolCall("Edit", { file_path: "shared.ts" }),
      ],
    });
    expect(r).toContain("Modified: shared.ts");
    expect(r).not.toContain("Created: shared.ts");
  });

  it("re-caps a merged Modified list at 10 with (+N more) (line 95 > limit branch)", async () => {
    // Covers: mergeFileLines cap() line 95 — arr.length > limit → slice(0, limit)
    // + "(+N more)" suffix. 6 paths from prev + 6 from fresh = 12 unique Modified.
    const files = Array.from({ length: 12 }, (_, i) => `f${i}.ts`);
    const previousSummary = `[Files And Changes]\n- Modified: ${files
      .slice(0, 6)
      .join(", ")}`;
    const messages: ReturnType<typeof userMsg>[] = [userMsg("edit many files")];
    for (const p of files.slice(6)) {
      messages.push(assistantWithToolCall("Edit", { file_path: p }));
    }
    const r = await compile({ previousSummary, messages });
    // Extract just the [Files And Changes] section (it ends at the next --- separator
    // or section header) so we assert only on its content, not on the brief transcript
    // where the file paths also appear via "* Edit \"fN.ts\"" one-liners.
    const sec = r.slice(
      r.indexOf("[Files And Changes]"),
      r.indexOf("\n\n---\n\n"),
    );
    expect(sec).toContain("(+2 more)");
    // cap() keeps slice(0, 10) — the FIRST ten (insertion order), drops last two.
    expect(sec).toContain("f0.ts");
    expect(sec).toContain("f9.ts");
    expect(sec).not.toMatch(/f10\.ts|f11\.ts/);
  });
});

describe("compile — additional summarize.ts branch coverage (Commits/Created/Read/empty)", () => {
  it("merges Commits section using the Commits CAP=8 ternary (line 60 middle branch)", async () => {
    // Covers: mergeHeaderSection line 60 — `header === "Commits" ? 8 : 15`.
    // BOTH prev and fresh must contribute non-empty Commits sections so the
    // `!prev`/`!fresh` early-returns are skipped and execution reaches line 60.
    const previousSummary = "[Commits]\n- abc1234: prev commit message";
    const r = await compile({
      previousSummary,
      messages: [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "tc", name: "bash", arguments: { command: 'git commit -m "fresh commit message"' } }],
          api: "messages" as never,
          provider: "anthropic" as never,
          model: "test",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          timestamp: Date.now(),
          stopReason: "toolUse",
        },
      ],
    });
    expect(r).toContain("[Commits]");
    expect(r).toContain("abc1234: prev commit message");
    expect(r).toContain("fresh commit message");
  });

  it("merges User Preferences section using the CAP=15 fallback ternary (line 60 right branch)", async () => {
    // Covers: mergeHeaderSection line 60 rightmost branch — neither Session Goal
    // nor Commits → CAP 15. User Preferences is the natural candidate header.
    // prev and fresh both contribute a `- ` preference line so both guards pass.
    const previousSummary = "[User Preferences]\n- prefers dark theme";
    const r = await compile({
      previousSummary,
      messages: [
        {
          role: "user",
          content: "prefer terse replies please",
          timestamp: Date.now(),
        } as never,
      ],
    });
    expect(r).toContain("[User Preferences]");
    expect(r).toContain("prefers dark theme");
  });

  it("omits headers block entirely when neither prev nor fresh has any headers (line 128 false branch)", async () => {
    // Covers: mergePrevious line 128 false branch — headers.length === 0 → skip
    // the headers push, AND line 131 false branch — mergedBrief falsy → skip the
    // brief push. Requires prev to be truthy (so mergePrevious runs) but contain
    // NEITHER a recognized header NOR a brief separator. A bare non-header string
    // with no `\n\n---\n\n` and no `[Header]` tag satisfies this.
    const r = await compile({
      previousSummary: "just some stray text with no structure",
      messages: [],
    });
    // No headers, no brief → mergedPrevious returns "" → compile returns "".
    expect(r).toBe("");
  });

  it("emits Created entry carried from prev when fresh only Reads (line 100 true branch)", async () => {
    // Covers: mergeFileLines line 100 — merged.Created.size > 0 → push Created line.
    // Fresh cannot itself produce a Created entry (Write/Edit tools add to BOTH
    // modified and created, then formatFileActivity demotes created→modified),
    // so the only way Created reaches mergeFileLines is from a prev `- Created:`
    // line that survives the cross-category dedup. Fresh must have a Files And
    // Changes section (here via a Read tool call) so `!fresh` is false and
    // mergeFileLines is actually entered.
    const previousSummary = "[Files And Changes]\n- Created: legacy-created.ts";
    const r = await compile({
      previousSummary,
      messages: [
        userMsg("read a file"),
        assistantWithToolCall("Read", { file_path: "fresh-read.ts" }),
      ],
    });
    const sec = r.slice(
      r.indexOf("[Files And Changes]"),
      r.indexOf("\n\n---\n\n"),
    );
    expect(sec).toContain("Created: legacy-created.ts");
    expect(sec).toContain("Read:");
    expect(sec).toContain("fresh-read.ts");
  });

  it("re-emits Read entry after merge when Read set is non-empty (line 101 true branch, re-verified)", async () => {
    // Covers: mergeFileLines line 101 — merged.Read.size > 0 → push Read line.
    // Both prev and fresh contribute Read entries.
    const previousSummary = "[Files And Changes]\n- Read: legacy-read.ts";
    const r = await compile({
      previousSummary,
      messages: [
        userMsg("read some files"),
        assistantWithToolCall("Read", { file_path: "fresh-read.ts" }),
      ],
    });
    const sec = r.slice(
      r.indexOf("[Files And Changes]"),
      r.indexOf("\n\n---\n\n"),
    );
    expect(sec).toContain("Read:");
    expect(sec).toContain("legacy-read.ts");
    expect(sec).toContain("fresh-read.ts");
  });

  it("joins merged headers when at least one header is present (line 128 true branch)", async () => {
    // Covers: mergePrevious line 128 — headers.length > 0 → parts.push(headers.join).
    // Straightforward: prev/fresh both contribute a Session Goal.
    const previousSummary = "[Session Goal]\n- old goal task";
    const r = await compile({
      previousSummary,
      messages: [userMsg("fresh goal task here")],
    });
    expect(r).toContain("[Session Goal]");
    // Multiple distinct bullets → joined under a single [Session Goal] header.
    const goals = r.slice(0, r.indexOf("\n\n---\n\n"));
    expect((goals.match(/\[Session Goal\]/g) ?? []).length).toBe(1);
  });
});

describe("compile — Session Goal / brief merge branch coverage", () => {
  it("uses fresh brief when previous summary had no brief section (line 107 !prev branch)", async () => {
    // Covers: mergeBriefTranscript `if (!prev) return fresh;` — previous has
    // headers but no `\n\n---\n\n` separator, so prevBrief is "".
    const previousSummary = "[Session Goal]\n- old goal with no brief";
    const r = await compile({
      previousSummary,
      messages: [userMsg("implement fresh feature task")],
    });
    expect(r).toContain("[user]");
    expect(r).toContain("implement fresh feature task");
  });

  it("preserves previous brief when fresh has no brief (line 108 !fresh branch)", async () => {
    // Covers: mergeBriefTranscript `if (!fresh) return prev;` — empty fresh
    // messages → freshBrief "" while prevBrief is non-empty.
    const previousSummary =
      "[Session Goal]\n- old goal\n\n---\n\n[user]\nold brief line";
    const r = await compile({
      previousSummary,
      messages: [],
    });
    expect(r).toContain("old brief line");
    expect(r).toContain("[user]");
  });

  it("caps merged Session Goal lines at 8 keeping the most recent (line 61 > CAP branch)", async () => {
    // Covers: mergeHeaderSession line 61 — combined.length > CAP → slice(-CAP).
    // Also exercises the Session Goal CAP=8 ternary branch (line 60).
    const prevGoals = Array.from(
      { length: 8 },
      (_, i) => `- prev goal number ${i}`,
    ).join("\n");
    const previousSummary = `[Session Goal]\n${prevGoals}`;
    const r = await compile({
      previousSummary,
      messages: [userMsg("implement brand new fresh goal task")],
    });
    // 9 unique goals → slice(-8) drops "prev goal number 0".
    expect(r).not.toContain("prev goal number 0");
    expect(r).toContain("prev goal number 7");
    expect(r).toContain("implement brand new fresh goal task");
  });
});
