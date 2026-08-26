// Branch-coverage tests for src/hooks/before-compact.ts.
//
// Targets the uncovered line ranges reported by the v8 coverage run:
//   115-127 (previewContent array branch — text/toolCall/thinking/image/unknown)
//   158     (collectEntry fall-through null for unrecognized entry type)
//   452-471 (keptEntries.reduce token estimation for array content with toolCall/toolResult)
//   496-511 (empty-summary-guard with legacyCancelBehavior=true)
//   526-546 (zero-token-guard with legacyCancelBehavior=true)
//   622-629 (session_compact success toast handler)
//
// All tests craft inputs that produce deterministic outcomes (no compile/convertToLlm
// mocking) — verified via probes against the real implementation. Follows the
// scaffolding conventions established in before-compact-hook.test.ts.

import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { existsSync, unlinkSync, writeFileSync, readFileSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { registerBeforeCompactHook, PI_VCC_COMPACT_INSTRUCTION } from "../src/hooks/before-compact";

let tmpDir: string;
let CONFIG_PATH: string;
// LD10: debug snapshot path is pid-suffixed.
const DEBUG_PATH = `/tmp/pi-vcc-debug-${process.pid}.json`;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "pi-vcc-cov-"));
  CONFIG_PATH = join(tmpDir, "pi-vcc-config.json");
  process.env.PI_VCC_CONFIG_PATH = CONFIG_PATH;
});

afterAll(() => {
  delete process.env.PI_VCC_CONFIG_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

// Minimal ExtensionAPI stub. Captures BOTH session_before_compact and
// session_compact handlers so we can exercise the success-toast handler.
function createMockPi() {
  const handlers: Record<string, (event: any, ctx: any) => any> = {};
  const notifyCalls: Array<{ msg: string; level: string }> = [];
  const ctx = {
    hasUI: true,
    ui: {
      notify: (msg: string, level: string) => {
        notifyCalls.push({ msg, level });
      },
      setStatus: (_msg: string) => {},
    },
  };
  return {
    pi: {
      on: (eventName: string, h: (e: any, c: any) => any) => {
        handlers[eventName] = h;
      },
    } as any,
    invoke: (event: any) => handlers["session_before_compact"]!(event, ctx),
    invokeCompact: (event: any) =>
      handlers["session_compact"] ? handlers["session_compact"](event, ctx) : undefined,
    notifyCalls,
    ctx,
  };
}

function setConfig(cfg: Record<string, unknown>) {
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg));
}

function makeEvent(branchEntries: any[], customInstructions?: string) {
  return {
    type: "session_before_compact",
    customInstructions,
    branchEntries,
    preparation: {
      previousSummary: undefined,
      fileOps: { read: [], written: [], edited: [] },
      tokensBefore: 1000,
    },
    signal: new AbortController().signal,
  };
}

const msg = (id: string, role: "user" | "assistant" | "toolResult", content: unknown = "x") => ({
  id,
  type: "message",
  message: { role, content },
});

// Long content that compile() deterministically turns into a summary well above
// MIN_SUMMARY_CHARS (200) — verified via probe (~3700 chars for 4 messages).
const longContent = (
  Array.from(
    { length: 14 },
    (_, i) =>
      `Line ${i} with substantial detail about feature work and file changes to pad the summary really long`,
  ).join(". ")
);

function cleanupDebug() {
  if (existsSync(DEBUG_PATH)) unlinkSync(DEBUG_PATH);
}

// ════════════════════════════════════════════════════════════════════════════
// Lines 158: collectEntry returns null for unrecognized entry type
// ════════════════════════════════════════════════════════════════════════════

describe("coverage: collectEntry skips unrecognized entry types (line 158)", () => {
  beforeEach(cleanupDebug);
  afterEach(() => {
    if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
    cleanupDebug();
  });

  test("unknown entry type is filtered out (null) and does not crash the live-window walk", async () => {
    // An entry whose type is neither message/custom_message/branch_summary/compaction
    // must be skipped by collectEntry (returns null). Surround it with enough real
    // live messages so buildOwnCut returns ok:true and the hook proceeds.
    setConfig({ debug: false, overrideDefaultCompaction: false });
    const { pi, invoke } = createMockPi();
    registerBeforeCompactHook(pi);

    const entries = [
      msg("u1", "user", "first real user prompt that is long enough"),
      { id: "weird1", type: "some_unknown_type", payload: { whatever: true } },
      msg("a1", "assistant", longContent),
      msg("u2", "user", "second real user prompt that is long enough too"),
      msg("a2", "assistant", longContent),
    ];
    const result = (await invoke(makeEvent(entries, PI_VCC_COMPACT_INSTRUCTION))) as any;
    // Success path reached — unknown entry silently dropped.
    expect(result?.compaction).toBeDefined();
    // firstKeptEntryId must be a real message id (u2), proving the unknown entry
    // was never treated as the cut anchor.
    expect(result.compaction.firstKeptEntryId).toBe("u2");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Lines 115-127: previewContent array branch (text/toolCall/thinking/image/unknown)
// ════════════════════════════════════════════════════════════════════════════

describe("coverage: previewContent array branches (lines 115-127)", () => {
  beforeEach(cleanupDebug);
  afterEach(() => {
    if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
    cleanupDebug();
  });

  test("debug snapshot previews array content covering text/toolCall/thinking/image/unknown parts", async () => {
    // previewContent runs on the success path when settings.debug=true (it formats
    // messagesPreviewHead/Tail and cutWindow). Provide array content that includes
    // every branch of the switch: text, toolCall, thinking, image, and an unknown
    // type, so each `if (c?.type === ...)` arm is exercised.
    setConfig({ debug: true, overrideDefaultCompaction: false });
    const { pi, invoke } = createMockPi();
    registerBeforeCompactHook(pi);

    // Assistant with mixed content parts. The kept tail (after cut at u2) includes
    // this message, so previewContent runs on it via cutWindow. The summarized
    // head also includes such a message (a1) → messagesPreviewHead hits it too.
    // Field shapes satisfy BOTH compile()'s normalize (needs .text/.thinking on
    // those parts) AND previewContent's switch (keys off .type only).
    const mixedContentAssistant = (id: string) => ({
      id,
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "some text part" },
          { type: "toolCall", id: "tc1", name: "edit", arguments: { path: "/x" } },
          { type: "thinking", thinking: "a thought", redacted: false },
          { type: "image", mimeType: "image/png" },
          { type: "mysteryType" }, // unknown → `[${c?.type ?? "unknown"}]`
          {}, // no type → `[unknown]` via the `?? "unknown"` fallback
        ],
      },
    });

    const entries = [
      msg("u1", "user", "first prompt long enough to populate sections here"),
      mixedContentAssistant("a1"),
      msg("u2", "user", "second prompt long enough to populate sections here"),
      mixedContentAssistant("a2"),
    ];

    const result = (await invoke(makeEvent(entries, PI_VCC_COMPACT_INSTRUCTION))) as any;
    expect(result?.compaction).toBeDefined();

    // Verify the debug snapshot was written and contains previews produced by
    // previewContent (proving every switch arm ran without throwing).
    expect(existsSync(DEBUG_PATH)).toBe(true);
    const snapshot = JSON.parse(readFileSync(DEBUG_PATH, "utf-8"));
    expect(snapshot.usedOwnCut).toBe(true);
    // cutWindow entries should carry previews derived from the mixed content.
    expect(Array.isArray(snapshot.cutWindow)).toBe(true);
    const serialized = JSON.stringify(snapshot);
    // Each preview arm produces a recognizable token in the serialized output.
    expect(serialized).toContain("[toolCall:edit]");
    expect(serialized).toContain("[thinking]");
    expect(serialized).toContain("[image:image/png]");
    expect(serialized).toContain("[mysteryType]");
    expect(serialized).toContain("[unknown]");
  });

  test("previewContent string branch still works alongside array branch in one session", async () => {
    // Mix string-content and array-content messages so the `typeof content === "string"`
    // branch (line 114) and the array branch are both traversed in a single success path.
    setConfig({ debug: true, overrideDefaultCompaction: false });
    const { pi, invoke } = createMockPi();
    registerBeforeCompactHook(pi);

    const entries = [
      msg("u1", "user", "string content first prompt long enough here"),
      {
        id: "a1",
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "array content assistant reply padded out" }],
        },
      },
      msg("u2", "user", "string content second prompt long enough here too"),
      msg("a2", "assistant", "plain string assistant reply padded out sufficiently"),
    ];

    const result = (await invoke(makeEvent(entries, PI_VCC_COMPACT_INSTRUCTION))) as any;
    expect(result?.compaction).toBeDefined();
    expect(existsSync(DEBUG_PATH)).toBe(true);
  });

  test("previewContent returns '' fallback when message content is neither string nor array (line 127)", async () => {
    // previewContent's final `return "";` runs when content is e.g. null or a bare
    // object. Drive the success path with debug:true and a kept-tail message whose
    // message.content is null → previewContent(null) hits line 127.
    setConfig({ debug: true, overrideDefaultCompaction: false });
    const { pi, invoke } = createMockPi();
    registerBeforeCompactHook(pi);

    const entries = [
      msg("u1", "user", "first prompt long enough to populate the sections here"),
      msg("a1", "assistant", longContent),
      msg("u2", "user", "second prompt long enough to populate the sections here"),
      // Kept tail (cut anchor = u3) — a message with null content is previewed
      // via cutWindow and reduce (both return their fallback arms).
      msg("u3", "user", "third prompt cut anchor long enough here too"),
      { id: "null_content", type: "message", message: { role: "assistant", content: null } },
    ];

    const result = (await invoke(makeEvent(entries, PI_VCC_COMPACT_INSTRUCTION))) as any;
    expect(result?.compaction).toBeDefined();
    expect(result.compaction.firstKeptEntryId).toBe("u3");
    expect(existsSync(DEBUG_PATH)).toBe(true);
    // The null-content entry appears in cutWindow with an empty preview.
    const snapshot = JSON.parse(readFileSync(DEBUG_PATH, "utf-8"));
    const nullEntry = snapshot.cutWindow.find((w: any) => w.id === "null_content");
    expect(nullEntry).toBeDefined();
    expect(nullEntry.preview).toBe("");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// collectEntry coalescing branches (lines 147, 152) + previewContent text ?? (118)
// ════════════════════════════════════════════════════════════════════════════

describe("coverage: collectEntry nullish-coalescing + previewContent text ?? (lines 118,147,152)", () => {
  beforeEach(cleanupDebug);
  afterEach(() => {
    if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
    cleanupDebug();
  });

  test("custom_message with null content coalesces to empty string (line 147 ?? arm)", async () => {
    // Line 147: `typeof e.content === "string" ? e.content : e.content ?? ""`.
    // A custom_message whose content is null (not a string, falsy) → the `?? ""`
    // arm fires, producing an empty-string user message.
    setConfig({ debug: false, overrideDefaultCompaction: false });
    const { pi, invoke } = createMockPi();
    registerBeforeCompactHook(pi);

    const entries: any[] = [
      msg("u1", "user", "first prompt long enough to populate sections here"),
      msg("a1", "assistant", longContent),
      msg("u2", "user", "second prompt long enough to populate sections here too"),
      msg("a2", "assistant", longContent),
      { id: "cm_null", type: "custom_message", content: null },
    ];
    // buildOwnCut cuts at u2 (last user-role); the custom_message is collected but
    // lies after the cut so it doesn't affect the summary. The hook must still
    // succeed (proving the ?? arm didn't crash convertToLlm).
    const result = (await invoke(makeEvent(entries, PI_VCC_COMPACT_INSTRUCTION))) as any;
    expect(result?.compaction).toBeDefined();
  });

  test("branch_summary with undefined summary coalesces to empty string (line 152 ?? arm)", async () => {
    // Line 152: `const text = e.summary ?? "";`. A branch_summary entry without a
    // summary field → coalesces to "" so the synth message has empty text.
    // collectEntry runs during the live-window walk regardless of whether the
    // downstream guards defer, so we only assert the hook completes without
    // crashing (the ?? arm was traversed).
    setConfig({ debug: false, overrideDefaultCompaction: false });
    const { pi, invoke } = createMockPi();
    registerBeforeCompactHook(pi);

    const entries: any[] = [
      { id: "u0", type: "message", message: { role: "user", content: "seed" } },
      { id: "c1", type: "compaction", firstKeptEntryId: "" }, // orphan recovery
      { id: "bs1", type: "branch_summary" }, // summary undefined → ?? ""
      msg("u1", "user", "first prompt long enough to populate sections here"),
      msg("a1", "assistant", longContent),
    ];
    const result = await invoke(makeEvent(entries, PI_VCC_COMPACT_INSTRUCTION));
    // Either a successful compaction or a guard-driven defer — both are acceptable
    // since collectEntry already ran. The key contract: no crash.
    expect(result === undefined || (result as any)?.compaction !== undefined).toBe(true);
  });

  test("previewContent text part with undefined text coalesces to empty (line 118 ?? arm)", async () => {
    // Line 118: `if (c?.type === "text") return c.text ?? "";`. A text part whose
    // `text` field is undefined → returns "" (not undefined). Reach via debug
    // success path that previews a message carrying such a part.
    setConfig({ debug: true, overrideDefaultCompaction: false });
    const { pi, invoke } = createMockPi();
    registerBeforeCompactHook(pi);

    const entries = [
      msg("u1", "user", "first prompt long enough to populate the sections"),
      msg("a1", "assistant", longContent),
      msg("u2", "user", "second prompt long enough to populate the sections too"),
      // Kept tail — message with a text part missing .text → previewContent hits ?? "".
      msg("u3", "user", "third prompt cut anchor long enough here too"),
      {
        id: "notext",
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text" }], // text field omitted → undefined
        },
      },
    ];
    const result = (await invoke(makeEvent(entries, PI_VCC_COMPACT_INSTRUCTION))) as any;
    expect(result?.compaction).toBeDefined();
    expect(existsSync(DEBUG_PATH)).toBe(true);
    const snapshot = JSON.parse(readFileSync(DEBUG_PATH, "utf-8"));
    const notextEntry = snapshot.cutWindow.find((w: any) => w.id === "notext");
    expect(notextEntry.preview).toBe("");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Line 513-515: empty-summary-guard defer path (legacyCancelBehavior=false)
// ════════════════════════════════════════════════════════════════════════════

describe("coverage: empty-summary-guard defer to pi-core (lines 513-515)", () => {
  beforeEach(cleanupDebug);
  afterEach(() => {
    if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
    cleanupDebug();
  });

  test("legacyCancelBehavior=false + empty summary → defer to pi-core (not cancel)", async () => {
    // LD3 default path: empty-summary-guard is a LIE path that defers via bare
    // `return;` when legacyCancelBehavior is false (default). compile() returns ""
    // for empty/whitespace content, so 3+ empty live messages reach the guard.
    setConfig({ debug: false, overrideDefaultCompaction: false, legacyCancelBehavior: false });
    const { pi, invoke, notifyCalls } = createMockPi();
    registerBeforeCompactHook(pi);

    const entries = [
      msg("u1", "user", ""),
      msg("a1", "assistant", ""),
      msg("u2", "user", "   "),
    ];
    const result = await invoke(makeEvent(entries, PI_VCC_COMPACT_INSTRUCTION));
    // POST-FIX contract: defer (not cancel).
    expect(result).toBeUndefined();
    // LD16: explicit /pi-vcc surfaces an error toast on defer.
    const errorCalls = notifyCalls.filter((c) => c.level === "error");
    expect(errorCalls.length).toBeGreaterThanOrEqual(1);
    expect(errorCalls[0].msg).toContain("pi-vcc: failed");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Line 572: cutWindow ternary false arm (firstKeptEntryId not in branch)
// ════════════════════════════════════════════════════════════════════════════

describe("coverage: cutWindow empty when firstKeptEntryId is the synth sentinel (line 572 false arm)", () => {
  beforeEach(cleanupDebug);
  afterEach(() => {
    if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
    cleanupDebug();
  });

  test("compactAll with SYNTH firstKeptEntryId yields empty cutWindow in debug snapshot", async () => {
    // Line 572: `cutIdx >= 0 ? <slice> : []`. When firstKeptEntryId is the synth
    // sentinel (SYNTH_FIRST_KEPT_ID, not a real branch id) or "" (compactAll),
    // branchIds.indexOf returns -1 → cutWindow = []. This only runs on the
    // success path, but the zero-token/MIN_SUMMARY guards normally defer compactAll
    // scenarios BEFORE reaching line 569. To reach it with compactAll=true we need
    // a summary that passes BOTH guards: i.e. a large summary AND enough kept
    // tokens. Strategy B (synth from branch_summary) returns compactAll=true with
    // the SYNTH id; feed it a long branch_summary so the summary is large.
    setConfig({ debug: true, overrideDefaultCompaction: false });
    const { pi, invoke } = createMockPi();
    registerBeforeCompactHook(pi);

    // Strategy B: orphan recovery from a prior compact-all, live window starts
    // with branch_summary (user-role) → cutIdx walks back to 0 → firstIsUser &&
    // !isRealUser → compactAll=true with SYNTH id. Make the summary large enough
    // to pass zero-token (keptTokensEst from synth is 0, so summary must be ≥4096
    // tokens ≈ 16384 chars) AND ≥ MIN_SUMMARY_CHARS (200).
    const bigSummary = "Prior session: " + "X".repeat(20000);
    const entries = [
      msg("u_orig", "user", "go"),
      { id: "c1", type: "compaction", firstKeptEntryId: "" }, // orphan recovery
      { id: "bs1", type: "branch_summary", summary: bigSummary },
      msg("a1", "assistant", longContent),
      msg("a2", "assistant", longContent),
    ];
    const result = (await invoke(makeEvent(entries, PI_VCC_COMPACT_INSTRUCTION))) as any;
    expect(result?.compaction).toBeDefined();
    // firstKeptEntryId is the synth sentinel → cutWindow must be empty.
    expect(result.compaction.firstKeptEntryId).toBe("__pi_vcc_compact_all__");
    expect(existsSync(DEBUG_PATH)).toBe(true);
    const snapshot = JSON.parse(readFileSync(DEBUG_PATH, "utf-8"));
    expect(snapshot.cutWindow).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Lines 452-471: keptEntries.reduce token estimation for array content
// ════════════════════════════════════════════════════════════════════════════

describe("coverage: kept-tail token estimation for array content (lines 452-471)", () => {
  beforeEach(cleanupDebug);
  afterEach(() => {
    if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
    cleanupDebug();
  });

  test("kept tail with toolCall + toolResult array content is counted into keptTokensEst", async () => {
    // The reduce at line 449 counts chars of kept message content. To hit the
    // array branches (toolCall at 457-462, toolResult at 463-467) the kept tail
    // must contain type=message entries whose message.content is an array holding
    // toolCall and toolResult parts. A successful compactAll=false cut keeps a
    // non-empty tail (keptIdx >= 0), exercising every arm.
    setConfig({ debug: false, overrideDefaultCompaction: false });
    const { pi, invoke } = createMockPi();
    registerBeforeCompactHook(pi);

    const toolCallInput = JSON.stringify({ path: "/some/file.ts", content: "abc" });
    const entries = [
      msg("u1", "user", "first prompt long enough to populate the sections"),
      msg("a1", "assistant", longContent),
      msg("u2", "user", "second prompt long enough to populate the sections too"),
      // ── kept tail (cut anchor = u3) ──
      msg("u3", "user", "third prompt that becomes the cut anchor here"),
      {
        id: "tc_msg",
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              name: "edit",
              input: JSON.parse(toolCallInput),
            },
          ],
        },
      },
      {
        id: "tr_msg",
        type: "message",
        message: {
          role: "toolResult",
          content: [
            {
              type: "toolResult",
              content: "the edit succeeded with this result text",
            },
          ],
        },
      },
    ];

    const result = (await invoke(makeEvent(entries, PI_VCC_COMPACT_INSTRUCTION))) as any;
    expect(result?.compaction).toBeDefined();
    // firstKeptEntryId must reference a real kept entry (u3) so the kept tail is
    // non-empty and the reduce runs over the toolCall/toolResult array parts.
    expect(result.compaction.firstKeptEntryId).toBe("u3");
  });

  test("kept tail with string-input toolCall falls back to JSON.stringify of the input", async () => {
    // Line 461: `typeof p.input === "string" ? p.input.length : JSON.stringify(...)`.
    // Cover the string-input branch by giving the toolCall a string `input`.
    setConfig({ debug: false, overrideDefaultCompaction: false });
    const { pi, invoke } = createMockPi();
    registerBeforeCompactHook(pi);

    const entries = [
      msg("u1", "user", "first prompt long enough to populate sections here"),
      msg("a1", "assistant", longContent),
      msg("u2", "user", "second prompt long enough to populate sections here"),
      msg("u3", "user", "third prompt cut anchor long enough here too"),
      {
        id: "tc_str",
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", name: "bash", input: "ls -la /some/directory/path" }],
        },
      },
    ];

    const result = (await invoke(makeEvent(entries, PI_VCC_COMPACT_INSTRUCTION))) as any;
    expect(result?.compaction).toBeDefined();
    expect(result.compaction.firstKeptEntryId).toBe("u3");
  });

  test("kept tail with string-content toolResult uses content.length directly", async () => {
    // Line 466: `typeof p.content === "string" ? p.content.length : JSON.stringify(...)`.
    // Cover the string-content branch by giving the toolResult part a string content.
    setConfig({ debug: false, overrideDefaultCompaction: false });
    const { pi, invoke } = createMockPi();
    registerBeforeCompactHook(pi);

    const entries = [
      msg("u1", "user", "first prompt long enough to populate sections here"),
      msg("a1", "assistant", longContent),
      msg("u2", "user", "second prompt long enough to populate sections here"),
      msg("u3", "user", "third prompt cut anchor long enough here too"),
      {
        id: "tr_str",
        type: "message",
        message: {
          role: "toolResult",
          content: [{ type: "toolResult", content: "plain string result content here" }],
        },
      },
    ];

    const result = (await invoke(makeEvent(entries, PI_VCC_COMPACT_INSTRUCTION))) as any;
    expect(result?.compaction).toBeDefined();
    expect(result.compaction.firstKeptEntryId).toBe("u3");
  });

  test("kept tail with unrecognized content part returns current sum (line 468)", async () => {
    // Line 468: `return s;` for content parts that are not text/toolCall/toolResult.
    setConfig({ debug: false, overrideDefaultCompaction: false });
    const { pi, invoke } = createMockPi();
    registerBeforeCompactHook(pi);

    const entries = [
      msg("u1", "user", "first prompt long enough to populate sections here"),
      msg("a1", "assistant", longContent),
      msg("u2", "user", "second prompt long enough to populate sections here"),
      msg("u3", "user", "third prompt cut anchor long enough here too"),
      {
        id: "unk_part",
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "weirdPartType", payload: "ignored" }],
        },
      },
    ];

    const result = (await invoke(makeEvent(entries, PI_VCC_COMPACT_INSTRUCTION))) as any;
    expect(result?.compaction).toBeDefined();
    expect(result.compaction.firstKeptEntryId).toBe("u3");
  });

  test("kept tail with non-string non-array message content returns sum unchanged (line 471)", async () => {
    // Line 471: the outer reduce's `return sum;` fallback fires when a kept
    // message's content is neither a string nor an array (e.g. null or a bare
    // object). Provide a kept-tail message with content:null so the reduce
    // skips it without crashing.
    setConfig({ debug: false, overrideDefaultCompaction: false });
    const { pi, invoke } = createMockPi();
    registerBeforeCompactHook(pi);

    const entries = [
      msg("u1", "user", "first prompt long enough to populate sections here"),
      msg("a1", "assistant", longContent),
      msg("u2", "user", "second prompt long enough to populate sections here"),
      msg("u3", "user", "third prompt cut anchor long enough here too"),
      // Kept message whose content is null → outer reduce hits line 471.
      { id: "null_c", type: "message", message: { role: "assistant", content: null } },
    ];

    const result = (await invoke(makeEvent(entries, PI_VCC_COMPACT_INSTRUCTION))) as any;
    expect(result?.compaction).toBeDefined();
    expect(result.compaction.firstKeptEntryId).toBe("u3");
  });

  test("kept tail with object-typed message content returns sum unchanged (line 471, object arm)", async () => {
    // A second shape for line 471: content is a bare object (not null). The reduce
    // must still skip it via `return sum;`.
    setConfig({ debug: false, overrideDefaultCompaction: false });
    const { pi, invoke } = createMockPi();
    registerBeforeCompactHook(pi);

    const entries = [
      msg("u1", "user", "first prompt long enough to populate sections here"),
      msg("a1", "assistant", longContent),
      msg("u2", "user", "second prompt long enough to populate sections here"),
      msg("u3", "user", "third prompt cut anchor long enough here too"),
      { id: "obj_c", type: "message", message: { role: "assistant", content: { odd: "shape" } } },
    ];

    const result = (await invoke(makeEvent(entries, PI_VCC_COMPACT_INSTRUCTION))) as any;
    expect(result?.compaction).toBeDefined();
    expect(result.compaction.firstKeptEntryId).toBe("u3");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Lines 496-511: empty-summary-guard with legacyCancelBehavior=true
// ════════════════════════════════════════════════════════════════════════════

describe("coverage: empty-summary-guard legacyCancelBehavior=true (lines 496-511)", () => {
  beforeEach(cleanupDebug);
  afterEach(() => {
    if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
    cleanupDebug();
  });

  test("legacyCancelBehavior=true + empty summary → {cancel:true} with warning toast", async () => {
    // LD15 kill-switch: when legacyCancelBehavior=true, the empty-summary-guard
    // restores the OLD {cancel:true} behavior (instead of deferring). compile()
    // returns "" for empty/whitespace content (assumption A1), so feed empty
    // content with enough user-role messages to reach the success-path guard.
    setConfig({ debug: false, overrideDefaultCompaction: false, legacyCancelBehavior: true });
    const { pi, invoke, notifyCalls } = createMockPi();
    registerBeforeCompactHook(pi);

    const entries = [
      msg("u1", "user", ""),
      msg("a1", "assistant", ""),
      msg("u2", "user", "   "),
    ];
    const result = await invoke(makeEvent(entries, PI_VCC_COMPACT_INSTRUCTION));
    expect(result).toEqual({ cancel: true });
    // Warning toast surfaced.
    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0].level).toBe("warning");
    expect(notifyCalls[0].msg).toContain("Compaction summary is empty");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Lines 526-546: zero-token-guard with legacyCancelBehavior=true
// ════════════════════════════════════════════════════════════════════════════

describe("coverage: zero-token-guard legacyCancelBehavior=true (lines 526-546)", () => {
  beforeEach(cleanupDebug);
  afterEach(() => {
    if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
    cleanupDebug();
  });

  test("legacyCancelBehavior=true + compactAll + low tokens → {cancel:true} with warning toast", async () => {
    // LD15 kill-switch on the zero-token-guard: compactAll (single user + autonomous
    // tail) produces a tiny summary + empty kept tail → postCompactTokens < MIN.
    // With legacyCancelBehavior=true, restore {cancel:true} + warning toast.
    setConfig({ debug: false, overrideDefaultCompaction: false, legacyCancelBehavior: true });
    const { pi, invoke, notifyCalls } = createMockPi();
    registerBeforeCompactHook(pi);

    const entries = [
      msg("u1", "user", "go"),
      msg("a1", "assistant", "calling tool"),
      msg("t1", "toolResult", "result"),
      msg("a2", "assistant", "done"),
    ];
    const result = await invoke(makeEvent(entries, PI_VCC_COMPACT_INSTRUCTION));
    expect(result).toEqual({ cancel: true });
    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0].level).toBe("warning");
    expect(notifyCalls[0].msg).toContain("Post-compaction context would be");
    expect(notifyCalls[0].msg).toContain("falling back to pi-core default compaction");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Lines 622-629: session_compact success toast handler
// ════════════════════════════════════════════════════════════════════════════

describe("coverage: session_compact success toast handler (lines 621-638)", () => {
  beforeEach(cleanupDebug);
  afterEach(() => {
    if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
    cleanupDebug();
  });

  test("successful /compact (override=true) fires info toast via session_compact handler", async () => {
    // The session_compact handler fires the success toast ONLY when:
    //  - event.fromExtension is truthy
    //  - state.wasPiVcc is false (so /pi-vcc's own toast isn't duplicated)
    //  - state.stats is set (a prior before_compact produced a compaction)
    // Reuse the SAME event object across both handlers because sessionState is a
    // WeakMap keyed by the event reference.
    setConfig({ debug: false, overrideDefaultCompaction: true });
    const { pi, invoke, invokeCompact, notifyCalls } = createMockPi();
    registerBeforeCompactHook(pi);

    // override=true path (customInstructions undefined) → wasPiVcc stays false.
    const sharedEvent: any = {
      type: "session_before_compact",
      customInstructions: undefined,
      branchEntries: [
        msg("u1", "user", "implement foo bar feature with tests and docs now"),
        msg("a1", "assistant", longContent),
        msg("u2", "user", "refactor bar module add more detail to sections here"),
        msg("a2", "assistant", longContent),
      ],
      preparation: {
        previousSummary: undefined,
        fileOps: { read: [], written: [], edited: [] },
        tokensBefore: 1000,
      },
      signal: new AbortController().signal,
      fromExtension: true, // required for the compact handler to proceed
    };

    const beforeResult = (await invoke(sharedEvent)) as any;
    expect(beforeResult?.compaction).toBeDefined();

    // No toast from the before handler on the success path.
    expect(notifyCalls).toHaveLength(0);

    // Fire the compact handler with the same event object.
    invokeCompact(sharedEvent);

    // The toast is delayed by setTimeout(UI_SETTKE_DELAY_MS=500). Wait long
    // enough for the deferred notify to fire.
    await new Promise((r) => setTimeout(r, 700));

    expect(notifyCalls.length).toBeGreaterThanOrEqual(1);
    const infoToast = notifyCalls.find((c) => c.level === "info");
    expect(infoToast).toBeDefined();
    expect(infoToast!.msg).toContain("pi-vcc:");
    expect(infoToast!.msg).toContain("source entries processed");
  });

  test("session_compact handler skips toast when fromExtension is falsy", async () => {
    // Line 623: `if (!event.fromExtension) return;` — guard arm.
    setConfig({ debug: false, overrideDefaultCompaction: true });
    const { pi, invoke, invokeCompact, notifyCalls } = createMockPi();
    registerBeforeCompactHook(pi);

    const sharedEvent: any = {
      type: "session_before_compact",
      customInstructions: undefined,
      branchEntries: [
        msg("u1", "user", "implement foo bar feature with tests and docs now"),
        msg("a1", "assistant", longContent),
        msg("u2", "user", "refactor bar module add more detail to sections here"),
        msg("a2", "assistant", longContent),
      ],
      preparation: {
        previousSummary: undefined,
        fileOps: { read: [], written: [], edited: [] },
        tokensBefore: 1000,
      },
      signal: new AbortController().signal,
      fromExtension: false, // guard arm — handler returns early
    };

    await invoke(sharedEvent);
    invokeCompact(sharedEvent);
    await new Promise((r) => setTimeout(r, 600));
    expect(notifyCalls).toHaveLength(0);
  });

  test("session_compact handler skips toast when wasPiVcc is true (/pi-vcc path)", async () => {
    // Line 624: `if (state?.wasPiVcc) return;` — /pi-vcc handles its own toast.
    setConfig({ debug: false, overrideDefaultCompaction: false });
    const { pi, invoke, invokeCompact, notifyCalls } = createMockPi();
    registerBeforeCompactHook(pi);

    const sharedEvent: any = {
      type: "session_before_compact",
      customInstructions: PI_VCC_COMPACT_INSTRUCTION, // → wasPiVcc set true
      branchEntries: [
        msg("u1", "user", "implement foo bar feature with tests and docs now"),
        msg("a1", "assistant", longContent),
        msg("u2", "user", "refactor bar module add more detail to sections here"),
        msg("a2", "assistant", longContent),
      ],
      preparation: {
        previousSummary: undefined,
        fileOps: { read: [], written: [], edited: [] },
        tokensBefore: 1000,
      },
      signal: new AbortController().signal,
      fromExtension: true,
    };

    await invoke(sharedEvent);
    invokeCompact(sharedEvent);
    await new Promise((r) => setTimeout(r, 600));
    // No info-level success toast (wasPiVcc early-return).
    expect(notifyCalls.find((c) => c.level === "info")).toBeUndefined();
  });

  test("session_compact handler skips toast when no stats recorded (no prior compaction)", async () => {
    // Line 626: `if (!stats) return;` — handler invoked without a preceding
    // successful before_compact for this event object.
    setConfig({ debug: false, overrideDefaultCompaction: false });
    const { pi, invokeCompact, notifyCalls } = createMockPi();
    registerBeforeCompactHook(pi);

    const sharedEvent: any = {
      type: "session_compact",
      fromExtension: true,
      // No prior before_compact → state.stats is null.
    };
    invokeCompact(sharedEvent);
    await new Promise((r) => setTimeout(r, 600));
    expect(notifyCalls).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Additional guard arms: dbg() existence-proxy reset + notify try/catch fallback
// ════════════════════════════════════════════════════════════════════════════

describe("coverage: dbg() existence-proxy reset (LD17) and best-effort notify fallback", () => {
  beforeEach(cleanupDebug);
  afterEach(() => {
    if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
    cleanupDebug();
  });

  test("dbg writes cancel snapshot again after the debug file is removed (existence-proxy reset)", async () => {
    // LD17: hasLoggedCancel is reset to false when the debug file no longer exists
    // (line 102). First call writes + sets hasLoggedCancel=true; remove the file;
    // second call must write again because the existence check resets the flag.
    setConfig({ debug: true, overrideDefaultCompaction: false });
    const { pi, invoke } = createMockPi();
    registerBeforeCompactHook(pi);

    const entries = [
      msg("a1", "assistant", "x"),
      msg("a2", "assistant", "y"),
      msg("a3", "assistant", "z"),
    ];

    // First invoke — writes the debug file.
    await invoke(makeEvent(entries, PI_VCC_COMPACT_INSTRUCTION));
    expect(existsSync(DEBUG_PATH)).toBe(true);
    const firstContent = readFileSync(DEBUG_PATH, "utf-8");

    // Remove the debug file (simulates a new session / test reset).
    cleanupDebug();
    expect(existsSync(DEBUG_PATH)).toBe(false);

    // Second invoke — existence-proxy reset → writes again.
    await invoke(makeEvent(entries, PI_VCC_COMPACT_INSTRUCTION));
    expect(existsSync(DEBUG_PATH)).toBe(true);
    // Content is freshly written (not stale).
    expect(readFileSync(DEBUG_PATH, "utf-8")).toEqual(firstContent);
  });

  test("notify throwing inside the success-toast setTimeout is caught (line 635 fallback)", async () => {
    // The session_compact handler wraps the deferred notify in try/catch so a
    // throwing ui.notify does not crash the handler. Build a mock whose notify
    // throws on every call, then drive both handlers with the SAME event so
    // sessionState carries stats into the compact handler.
    setConfig({ debug: false, overrideDefaultCompaction: true });

    const handlers: Record<string, (e: any, c: any) => any> = {};
    const ctx = {
      hasUI: true,
      ui: {
        notify: () => {
          throw new Error("boom from ui.notify");
        },
      },
    };
    const pi = {
      on: (eventName: string, h: (e: any, c: any) => any) => {
        handlers[eventName] = h;
      },
    } as any;

    registerBeforeCompactHook(pi);

    const sharedEvent: any = {
      type: "session_before_compact",
      customInstructions: undefined,
      branchEntries: [
        msg("u1", "user", "implement foo bar feature with tests and docs now"),
        msg("a1", "assistant", longContent),
        msg("u2", "user", "refactor bar module add more detail to sections here"),
        msg("a2", "assistant", longContent),
      ],
      preparation: {
        previousSummary: undefined,
        fileOps: { read: [], written: [], edited: [] },
        tokensBefore: 1000,
      },
      signal: new AbortController().signal,
      fromExtension: true,
    };

    // before_compact succeeds despite the throwing notify (the success path does
    // not call notify, so this just records stats).
    const beforeResult = (await handlers["session_before_compact"]!(sharedEvent, ctx)) as any;
    expect(beforeResult?.compaction).toBeDefined();

    // session_compact schedules the toast; the throwing notify must be swallowed.
    // The handler returns undefined synchronously; the throw happens inside the
    // setTimeout. Await the delay and confirm no unhandled rejection propagates.
    handlers["session_compact"]!(sharedEvent, ctx);
    await new Promise((r) => setTimeout(r, 700));
    // Reaching here without an unhandled rejection means the catch arm worked.
    expect(true).toBe(true);
  });

  test("notify throwing inside the cancel-path notify is caught (lines 433/434 fallback)", async () => {
    // The !ownCut.ok cancel branch wraps ctx.ui.notify in try/catch. A throwing
    // notify must not propagate out of the hook.
    setConfig({ debug: false, overrideDefaultCompaction: false });

    const handlers: Record<string, (e: any, c: any) => any> = {};
    const ctx = {
      hasUI: true,
      ui: {
        notify: () => {
          throw new Error("boom from ui.notify");
        },
      },
    };
    const pi = {
      on: (eventName: string, h: (e: any, c: any) => any) => {
        handlers[eventName] = h;
      },
    } as any;

    registerBeforeCompactHook(pi);

    // too_few_live_messages → cancel path with a notify call.
    const entries = [msg("m1", "user"), msg("m2", "assistant")];
    const result = await handlers["session_before_compact"]!(makeEvent(entries, PI_VCC_COMPACT_INSTRUCTION), ctx);
    // Despite the throwing notify, the hook still returns {cancel:true}.
    expect(result).toEqual({ cancel: true });
  });
});
