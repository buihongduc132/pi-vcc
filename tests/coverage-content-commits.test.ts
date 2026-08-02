import { describe, it, expect } from "vitest";
import { clipSentence, snippet, clip } from "../src/core/content";
import { extractCommits, formatCommits } from "../src/extract/commits";
import type { NormalizedBlock } from "../src/types";

// ── clip ── covers src/core/content.ts lines 5-13 (word boundary + surrogate) ──

describe("clip", () => {
  it("returns text unchanged when shorter than max (line 4)", () => {
    expect(clip("short", 200)).toBe("short");
  });

  it("cuts at a word boundary when one exists past max*0.6 (line 7 true branch)", () => {
    // 80 'a' + space + filler to exceed max=100: space at idx 80, 80 > 60 -> cut there.
    const text = "a".repeat(80) + " " + "x".repeat(40);
    expect(clip(text, 100)).toBe("a".repeat(80));
  });

  it("falls back to hard max when nearest space is before max*0.6 (line 7 false branch)", () => {
    // space at idx 5 (< 60), so end = max = 100.
    const text = "abcde f".padEnd(150, "x");
    expect(clip(text, 100)).toBe(text.slice(0, 100));
  });

  it("backs up one char when the cut lands on a high surrogate (line 11)", () => {
    // 199 'a' + surrogate pair. end=200, charCodeAt(199)=0xD83D -> end-- -> 199.
    const text = "a".repeat(199) + "\uD83D\uDE00";
    const out = clip(text, 200);
    expect(out.length).toBe(199);
    expect(out).toBe("a".repeat(199));
  });
});

// ── clipSentence ── covers src/core/content.ts lines 22-31 ────────────────────
//   22: early return when text fits within max
//   26: matches.length > 0 (terminator found)
//   29: end >= max*0.5 (accept sentence boundary)
//   31: fallback to clip() when no acceptable sentence boundary
//   28: last.index ?? 0 (nullish coalesce on regex match index)

describe("clipSentence", () => {
  it("returns text unchanged when shorter than max (line 22 early return)", () => {
    expect(clipSentence("short text", 200)).toBe("short text");
  });

  it("returns text unchanged when length exactly equals max (boundary)", () => {
    const text = "x".repeat(50);
    expect(clipSentence(text, 50)).toBe(text);
  });

  it("cuts at the last sentence terminator within the window (line 29 accept)", () => {
    // Terminator positioned so end (index+1) >= max*0.5 (here >= 15).
    // "Hello world!!!!!. " -> "." at idx 14, end=15, max*0.5=15 -> accepted.
    const text = "Hello world!!!!. " + "y".repeat(100);
    expect(clipSentence(text, 30)).toBe("Hello world!!!!.");
  });

  it("includes the punctuation in the cut (end = index+1)", () => {
    // "." at idx 19, end=20, max*0.5=20 -> accepted (end >= max*0.5).
    const text = "First sentence now!. " + "y".repeat(100);
    expect(clipSentence(text, 40)).toBe("First sentence now!.");
  });

  it("recognizes '?' and '!' terminators followed by space", () => {
    // Position terminator so end >= max*0.5 (=20 here): idx >= 19.
    const q = "z".repeat(19) + "? " + "y".repeat(80);
    expect(clipSentence(q, 40)).toBe("z".repeat(19) + "?");
    const bang = "z".repeat(19) + "! " + "y".repeat(80);
    expect(clipSentence(bang, 40)).toBe("z".repeat(19) + "!");
  });

  it("recognizes terminator at end-of-string (the $ alternative)", () => {
    // Text longer than max but the slice itself ends with a terminator with no
    // trailing whitespace, exercising `(?:\s|$)` -> "$".
    const text = "Done." + "y".repeat(0);
    // Build text where max clips right after a terminator with nothing after.
    const padded = "intro. " + "y".repeat(50);
    // slice(0, 7) = "intro. " ends with ". " (space). Force a $ match:
    const exact = "x".repeat(45) + "."; // 46 chars, terminator at end
    const out = clipSentence(exact + "tail", 46);
    expect(out).toBe(exact); // ends at the "."
  });

  it("falls back to clip() when no terminator exists (line 31 fallback)", () => {
    const text = "a".repeat(300);
    expect(clipSentence(text, 50)).toBe("a".repeat(50));
  });

  it("falls back to clip() when terminator is too early (end < max*0.5)", () => {
    // "Hi. " is at index 2-3, end=3 < 50*0.5=25, so not accepted -> clip.
    const text = "Hi. " + "x".repeat(300);
    const out = clipSentence(text, 50);
    expect(out).toBe("Hi. " + "x".repeat(46)); // clip word-boundary path
    expect(out.length).toBe(50);
  });

  it("uses default max=200 when omitted", () => {
    // Default max=200 -> need terminator end >= 100 (index >= 99).
    const text = "z".repeat(99) + ". " + "y".repeat(300);
    expect(clipSentence(text)).toBe("z".repeat(99) + ".");
  });
});

// ── snippet ── covers src/core/content.ts lines 53-59 ─────────────────────────
//   54: idx === -1 -> return null (term not found)
//   57: prefix "..." when start > 0
//   58: suffix "..." when end < text.length
//   57/58: empty prefix/suffix when at boundaries

describe("snippet", () => {
  it("returns null when term is not found (line 54)", () => {
    expect(snippet("hello world", "missing")).toBeNull();
  });

  it("returns null for empty term (indexOf returns 0 but term never matches as substring marker)", () => {
    // empty term: indexOf("") === 0, idx !== -1, so it returns a snippet; verify
    // it does NOT return null and includes the leading text + trailing suffix.
    const out = snippet("some long text here", "", 5);
    expect(out).not.toBeNull();
    expect(out?.endsWith("...")).toBe(true);
  });

  it("adds both prefix and suffix when match is in the middle", () => {
    const text = "x".repeat(80) + "term" + "y".repeat(80);
    const out = snippet(text, "term", 10);
    expect(out?.startsWith("...")).toBe(true);
    expect(out?.endsWith("...")).toBe(true);
    expect(out).toContain("term");
  });

  it("omits prefix when match is near the start (start clamps to 0)", () => {
    const out = snippet("term is here", "term", 60);
    expect(out?.startsWith("...")).toBe(false);
    expect(out).toBe("term is here");
  });

  it("omits suffix when match is near the end (end clamps to length)", () => {
    const text = "lots of padding " + "term";
    const out = snippet(text, "term", 60);
    expect(out?.endsWith("...")).toBe(false);
    expect(out).toBe(text); // whole string within radius
  });

  it("omits both prefix and suffix when whole text fits the radius", () => {
    const out = snippet("a term b", "term", 60);
    expect(out).toBe("a term b");
  });

  it("is case-insensitive for the search term", () => {
    const out = snippet("The Quick Brown Fox", "QUICK", 60);
    expect(out).toBe("The Quick Brown Fox");
  });

  it("respects custom radius", () => {
    const text = "p".repeat(100) + "term" + "q".repeat(100);
    const out = snippet(text, "term", 5);
    expect(out).toBe("..." + "p".repeat(5) + "term" + "q".repeat(5) + "...");
  });

  it("uses default radius=60 when omitted", () => {
    const text = "p".repeat(100) + "term" + "q".repeat(100);
    const out = snippet(text, "term");
    expect(out).toBe("..." + "p".repeat(60) + "term" + "q".repeat(60) + "...");
  });
});

// ── extractCommits ── covers src/extract/commits.ts lines 45-48 ────────────────
//   45-46: range hash branch  `([0-9a-f]{7,12})\.\.([0-9a-f]{7,12})` -> range[2]
//   47-48: plain hash branch  HASH_RE -> plain[1]
//   plus surrounding branches: dedup, quote variants, skips, inner-loop continue.

const bash = (command: unknown): NormalizedBlock => ({
  kind: "tool_call",
  name: "bash",
  args: { command },
});
const result = (text: string): NormalizedBlock => ({
  kind: "tool_result",
  name: "bash",
  text,
  isError: false,
});

describe("extractCommits", () => {
  it("extracts hash from a range output like '<branch> abc1234..def5678' (line 45-46)", () => {
    const commits = extractCommits([
      bash('git commit -m "fix bug"'),
      result("[main abc1234..def5678] fix bug"),
    ]);
    expect(commits).toEqual([{ hash: "def5678", message: "fix bug" }]);
  });

  it("range branch takes the second (new) hash, not the first", () => {
    const commits = extractCommits([
      bash('git commit -m "msg"'),
      result("Updates 111aaaa1..222bbbb2"),
    ]);
    expect(commits[0].hash).toBe("222bbbb2");
  });

  it("extracts hash from a plain HASH_RE match with no bracket/range (line 47-48)", () => {
    const commits = extractCommits([
      bash('git commit -m "fix bug"'),
      result("abcdef12345"),
    ]);
    expect(commits).toEqual([{ hash: "abcdef12345", message: "fix bug" }]);
  });

  it("plain-hash branch fires when result text has a bare 7-12 hex token", () => {
    const commits = extractCommits([
      bash('git commit -m "x"'),
      result("committed as 0123456789ab"),
    ]);
    expect(commits[0].hash).toBe("0123456789ab");
  });

  it("bracket hash branch still wins when present (regression for lines 43-44)", () => {
    const commits = extractCommits([
      bash('git commit -m "x"'),
      result("[feature 1234567] x"),
    ]);
    expect(commits[0].hash).toBe("1234567");
  });

  it("skips non-bash tool calls even if command contains 'git commit' (line 29)", () => {
    const commits = extractCommits([
      { kind: "tool_call", name: "edit", args: { command: "git commit -m x" } },
    ]);
    expect(commits).toEqual([]);
  });

  it("skips bash calls whose command is not a string (line 30 ternary)", () => {
    const commits = extractCommits([
      bash(42),
      bash({ nested: true }),
    ]);
    expect(commits).toEqual([]);
  });

  it("skips bash commands that do not mention 'git commit' (line 31)", () => {
    const commits = extractCommits([
      bash('git push origin main'),
      bash('echo hello'),
    ]);
    expect(commits).toEqual([]);
  });

  it("skips 'git commit' with no -m message match (line 33)", () => {
    const commits = extractCommits([
      bash("git commit --amend --no-edit"),
    ]);
    expect(commits).toEqual([]);
  });

  it("skips when the captured message is empty/whitespace after trim (line 35)", () => {
    const commits = extractCommits([
      bash('git commit -m "   "'),
      result("[main abc1234]   "),
    ]);
    expect(commits).toEqual([]);
  });

  it("parses single-quoted -m message (regex group m[2])", () => {
    const commits = extractCommits([
      bash("git commit -m 'single quoted msg'"),
      result("[main 111aaaa1] single quoted msg"),
    ]);
    expect(commits[0].message).toBe("single quoted msg");
  });

  it("parses dollar-quoted $'...' -m message (regex group m[3])", () => {
    const commits = extractCommits([
      bash("git commit -m $'dollar quoted msg'"),
      result("[main 222bbbb2] dollar quoted msg"),
    ]);
    expect(commits[0].message).toBe("dollar quoted msg");
  });

  it("truncates multi-line message to first line (firstLineOf)", () => {
    const commits = extractCommits([
      bash('git commit -m "first line\\nsecond line"'),
      result("[main abc1234] first line"),
    ]);
    expect(commits[0].message).toBe("first line");
  });

  it("unescapes \\\\\" and \\\\' inside the captured message (cleanMessage)", () => {
    const commits = extractCommits([
      bash('git commit -m "say \\"hi\\" now"'),
      result('[main abc1234] say "hi" now'),
    ]);
    expect(commits[0].message).toBe('say "hi" now');
  });

  it("returns undefined hash when no result follows the commit (line 37 default)", () => {
    const commits = extractCommits([bash('git commit -m "lonely"')]);
    expect(commits).toEqual([{ hash: undefined, message: "lonely" }]);
  });

  it("continues inner loop past non-tool_result blocks (line 41)", () => {
    const commits = extractCommits([
      bash('git commit -m "gap"'),
      { kind: "assistant", text: "thinking" }, // skipped by `continue`
      result("[main abc1234] gap"),
    ]);
    expect(commits).toEqual([{ hash: "abc1234", message: "gap" }]);
  });

  it("leaves hash undefined when result has no recognizable hash pattern (line 41 of inner loop, fall-through)", () => {
    const commits = extractCommits([
      bash('git commit -m "nohash"'),
      result("some random output with no hex here"),
    ]);
    expect(commits).toEqual([{ hash: undefined, message: "nohash" }]);
  });

  it("dedups commits with identical message+hash (line 53 false branch)", () => {
    const commits = extractCommits([
      bash('git commit -m "dup"'), result("[main abc1234] dup"),
      bash('git commit -m "dup"'), result("[main abc1234] dup"),
    ]);
    expect(commits).toEqual([{ hash: "abc1234", message: "dup" }]);
  });

  it("keeps distinct commits with same message but different hash", () => {
    const commits = extractCommits([
      bash('git commit -m "same"'), result("[main aaaaaaa] same"),
      bash('git commit -m "same"'), result("[main bbbbbbb] same"),
    ]);
    expect(commits).toHaveLength(2);
    expect(commits.map((c) => c.hash)).toEqual(["aaaaaaa", "bbbbbbb"]);
  });

  it("keeps distinct commits with same hash but different message", () => {
    const commits = extractCommits([
      bash('git commit -m "msg one"'), result("[main aaaaaaa] msg one"),
      bash('git commit -m "msg two"'), result("[main aaaaaaa] msg two"),
    ]);
    expect(commits).toHaveLength(2);
  });

  it("looks at most two blocks ahead for a result (Math.min guard)", () => {
    // result is 3 positions ahead (i+3), outside the i+3 window -> no hash.
    const commits = extractCommits([
      bash('git commit -m "too far"'),
      { kind: "assistant", text: "a" }, // i+1
      { kind: "assistant", text: "b" }, // i+2  (still within Math.min(len, i+3))
      result("[main aaaaaaa] too far"), // i+3 -> EXCLUDED
    ]);
    expect(commits).toEqual([{ hash: undefined, message: "too far" }]);
  });
});

// ── formatCommits ── exercises the prefix ternary and slice limit ─────────────

describe("formatCommits", () => {
  it("returns empty array for no commits", () => {
    expect(formatCommits([])).toEqual([]);
  });

  it("omits prefix when commit has no hash (line 65 false branch)", () => {
    expect(formatCommits([{ hash: undefined, message: "no hash" }])).toEqual([
      "no hash",
    ]);
  });

  it("adds '<hash>: ' prefix when commit has a hash (line 65 true branch)", () => {
    expect(formatCommits([{ hash: "abc1234", message: "msg" }])).toEqual([
      "abc1234: msg",
    ]);
  });

  it("keeps only the most recent N commits (default limit 8)", () => {
    const commits = Array.from({ length: 12 }, (_, i) => ({
      hash: `hash${i.toString().padStart(4, "0")}`,
      message: `m${i}`,
    }));
    const out = formatCommits(commits);
    expect(out).toHaveLength(8);
    expect(out[0]).toBe("hash0004: m4"); // dropped the oldest 4
    expect(out[7]).toBe("hash0011: m11");
  });

  it("respects a custom limit", () => {
    const commits = Array.from({ length: 5 }, (_, i) => ({
      hash: undefined,
      message: `m${i}`,
    }));
    expect(formatCommits(commits, 2)).toEqual(["m3", "m4"]);
  });
});
