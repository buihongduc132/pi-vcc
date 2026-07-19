// RED-phase TDD for pi-vcc no_user_message deadlock fix.
//
// All tests in this file assert POST-FIX behavior per LD1-LD18 (see
// pi-plugins/flow/findings/2026-07-19-vcc-no-user-message-deadlock/).
// In RED phase, control tests PASS, all other tests FAIL — driving the
// implementation work in the GREEN phase.
//
// ASSUMPTIONS (verified):
//  - A1: compile({messages}) returns "" deterministically when message content
//        is empty or whitespace-only (verified via probe — see commit history).
//        Used for LIE-PATH-empty-summary-guard-defers without mocking compile.
//  - A2: convertToLlm passthrough on Message-shaped inputs (verified). The hook
//        extracts .message and passes it; for empty-content msgs the conv output
//        remains empty → compile returns "".
//  - A3: buildOwnCut is exported from src/hooks/before-compact (verified).
//  - A4: registerBeforeCompactHook captures only the LAST session_before_compact
//        handler via pi.on(); reusing createMockPi pattern from
//        before-compact-hook.test.ts.
//
// NO convertToLlm / compile mocks — inputs crafted to produce known outputs.

import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { existsSync, unlinkSync, writeFileSync, readFileSync, mkdtempSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  buildOwnCut,
  registerBeforeCompactHook,
  PI_VCC_COMPACT_INSTRUCTION,
} from "../src/hooks/before-compact";
import {
  customMsg,
  branchSummaryMsg,
  branchMsg,
  branchComp,
} from "./fixtures";

// ─── Shared test scaffolding ─────────────────────────────────────────────────

let tmpDir: string;
let CONFIG_PATH: string;
const DEBUG_PATH_SHARED = "/tmp/pi-vcc-debug.json";
const debugPathPid = () => `/tmp/pi-vcc-debug-${process.pid}.json`;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "pi-vcc-strat-"));
  CONFIG_PATH = join(tmpDir, "pi-vcc-config.json");
  process.env.PI_VCC_CONFIG_PATH = CONFIG_PATH;
});

afterAll(() => {
  delete process.env.PI_VCC_CONFIG_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

function createMockPi() {
  let handler: ((event: any, ctx: any) => any) | undefined;
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
        if (eventName === "session_before_compact") handler = h;
      },
    } as any,
    invoke: (event: any) => handler!(event, ctx),
    notifyCalls,
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

// Crafted content that compile() deterministically turns into "" (per A1).
const EMPTY = "";
const WS = "   ";

function cleanupDebugArtifacts() {
  for (const p of [DEBUG_PATH_SHARED, debugPathPid()]) {
    if (existsSync(p)) unlinkSync(p);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Strategy A — collect custom_message entries, treat as user-role
// ════════════════════════════════════════════════════════════════════════════

describe("buildOwnCut: Strategy A — custom_message collection", () => {
  test("STRATEGY-A-with-custom-message: live window with custom_message entries → ok:true at custom_message boundary", () => {
    // Post-fix: custom_message entries MUST be visible to the cut walk.
    // Today: buildOwnCut filters e.type==='message' → custom_message invisible
    // → no user-role found in live window → no_user_message.
    //
    // Fixture: post-compaction tail has 3 message entries (assistant / toolResult
    // only — no user-role) + 2 custom_message entries (the autonomous injections).
    const entries = [
      branchMsg("u1", "user", "go"),
      branchComp("c1", "u1"),
      branchMsg("a1", "assistant", "thinking..."),
      branchMsg("t1", "toolResult", "result"),
      branchMsg("a2", "assistant", "more"),
      customMsg("cm1", "pi_goal_continuation", "<pi_goal_continuation>step</pi_goal_continuation>"),
      customMsg("cm2", "intercom", "peer msg"),
    ];
    const r = buildOwnCut(entries as any);
    // POST-FIX contract:
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // firstKeptEntryId must be NON-EMPTY and reference a real entry (per LD6 —
    // "" sentinel would loop). Custom_message id is acceptable.
    expect(r.firstKeptEntryId).not.toBe("");
    expect(r.firstKeptEntryId).toBeTruthy();
  });

  test("STRATEGY-A-baseline-existing-user: live window with normal user msg → unchanged (CONTROL)", () => {
    // Control — must PASS today and post-fix. Verifies Strategy A doesn't
    // regress the existing-user path.
    const entries = [
      branchComp("c1", "u1"),
      branchMsg("u1", "user", "hello"),
      branchMsg("a1", "assistant", "hi"),
      branchMsg("u2", "user", "go"),
      branchMsg("a2", "assistant", "ok"),
    ];
    const r = buildOwnCut(entries as any);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.firstKeptEntryId).toBe("u2");
    expect(r.compactAll).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Strategy B — synth user from prior compaction summary
// ════════════════════════════════════════════════════════════════════════════

describe("buildOwnCut: Strategy B — synth from prior summary", () => {
  test("STRATEGY-B-synth-from-prior-summary: no user in live window, prior summary available → ok:true with non-empty firstKeptEntryId", () => {
    // Post-fix: when live window has no user-role msg, buildOwnCut MUST consult
    // the prior compaction's summary (via branch_summary entry) and synthesize a
    // user-role anchor. Returns NON-EMPTY firstKeptEntryId (LD6: "" sentinel
    // causes infinite compactAll loop).
    //
    // Today: returns {ok:false, reason:"no_user_message"} → deadlock.
    const entries = [
      branchMsg("u_orig", "user", "go"),
      branchComp("c1", ""),
      branchSummaryMsg("bs1", "prior context: user was working on X"),
      branchMsg("a1", "assistant", "thinking..."),
      branchMsg("t1", "toolResult", "result"),
      branchMsg("a2", "assistant", "more"),
    ];
    const r = buildOwnCut(entries as any);
    // POST-FIX contract:
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.firstKeptEntryId).not.toBe(""); // LD6 — break-the-loop guard
    expect(r.firstKeptEntryId).toBeTruthy();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Strategy C — cut at last assistant, walk back from toolResult
// ════════════════════════════════════════════════════════════════════════════

describe("buildOwnCut: Strategy C — cut at assistant", () => {
  test("STRATEGY-C-cut-at-assistant: live window = [asst, toolResult, asst] → cut at last assistant, non-empty firstKeptEntryId", () => {
    // Post-fix: no user, no prior summary → cut at LAST assistant entry.
    // firstKeptEntryId points to the assistant entry (non-empty).
    //
    // Today: returns {ok:false, reason:"no_user_message"}.
    const entries = [
      branchComp("c1", ""),
      branchMsg("a1", "assistant", "first"),
      branchMsg("t1", "toolResult", "result"),
      branchMsg("a2", "assistant", "second"),
    ];
    const r = buildOwnCut(entries as any);
    // POST-FIX contract:
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.firstKeptEntryId).not.toBe("");
    // firstKeptEntryId MUST reference a real entry that is an assistant (or
    // earlier) — never a toolResult (would orphan a toolCall per LD7).
    expect(r.firstKeptEntryId).toMatch(/^a\d+$/);
  });

  test("STRATEGY-C-walk-back-from-toolResult: live window ends in toolResult → walk back to nearest assistant/user, never cut AT toolResult", () => {
    // Post-fix (LD7): when live window ends with toolResult, cut walk MUST
    // continue backward to the nearest assistant/user entry. Cutting at
    // toolResult orphans the preceding toolCall → LLM API errors.
    //
    // Today: returns no_user_message (walk only checks role==='user' and
    // terminates at cutIdx=0; firstKeptEntryId never set for this shape).
    const toolCallArgs = JSON.stringify({ path: "/x" });
    const entries = [
      branchComp("c1", ""),
      branchMsg("u1", "user", "go"),
      {
        id: "asst_tc",
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "tc_99", name: "edit", arguments: JSON.parse(toolCallArgs) }],
        },
      },
      branchMsg("tr1", "toolResult", "edit result"),
      branchMsg("a_final", "assistant", "summary"),
      branchMsg("tr_orphan", "toolResult", "result with no preceding toolCall"),
    ];
    const r = buildOwnCut(entries as any);
    // POST-FIX contract:
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.firstKeptEntryId).not.toBe("");
    // Critical: firstKeptEntryId MUST NOT point at a toolResult entry.
    expect(r.firstKeptEntryId).not.toBe("tr1");
    expect(r.firstKeptEntryId).not.toBe("tr_orphan");
    // Should reference either the user, the toolCall-bearing assistant, or the
    // final assistant — never a bare toolResult.
    expect(["u1", "asst_tc", "a_final"]).toContain(r.firstKeptEntryId);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Strategy D — defer to pi-core when live window has only toolResult entries
// ════════════════════════════════════════════════════════════════════════════

describe("buildOwnCut + hook: Strategy D — defer when all toolResult", () => {
  test("STRATEGY-D-defer-when-all-toolResult: buildOwnCut returns no_user_message AND hook returns undefined (defer, not cancel)", async () => {
    // Post-fix (LD8): buildOwnCut still returns {ok:false, reason:"no_user_message"}
    // for a toolResult-only live window — but the HOOK HANDLER returns bare
    // `undefined;` so pi-core's default compaction runs.
    //
    // Today: hook returns {cancel:true} → compaction blocked entirely.
    setConfig({ debug: false, overrideDefaultCompaction: false });
    const { pi, invoke } = createMockPi();
    registerBeforeCompactHook(pi);

    const entries = [
      branchComp("c1", ""),
      branchMsg("tr1", "toolResult", "r1"),
      branchMsg("tr2", "toolResult", "r2"),
      branchMsg("tr3", "toolResult", "r3"),
    ];

    // buildOwnCut contract (unchanged): no_user_message
    const cut = buildOwnCut(entries as any);
    expect(cut.ok).toBe(false);
    if (cut.ok) return;
    expect(cut.reason).toBe("no_user_message");

    // Hook contract (POST-FIX): defer to pi-core, do NOT cancel.
    const result = await invoke(makeEvent(entries, PI_VCC_COMPACT_INSTRUCTION));
    expect(result).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Lie-path tests — hook-level defer behavior
// ════════════════════════════════════════════════════════════════════════════

describe("registerBeforeCompactHook: lie paths (defer, not cancel)", () => {
  beforeEach(cleanupDebugArtifacts);
  afterEach(() => {
    if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
    cleanupDebugArtifacts();
  });

  test("LIE-PATH-empty-summary-guard-defers: compile() returns empty → hook returns undefined (not {cancel:true})", async () => {
    // Post-fix (LD3): empty-summary-guard is a LIE path today — it claims to
    // fall back to pi-core but actually {cancel:true} blocks the fallback.
    // Must return bare `undefined;` to truly defer.
    //
    // Setup: 3+ live msgs with user role so buildOwnCut returns ok:true, then
    // empty/whitespace content forces compile() to return "" (per A1).
    setConfig({ debug: false, overrideDefaultCompaction: false });
    const { pi, invoke } = createMockPi();
    registerBeforeCompactHook(pi);

    const entries = [
      branchMsg("u1", "user", EMPTY),
      branchMsg("a1", "assistant", EMPTY),
      branchMsg("u2", "user", WS),
    ];
    const result = await invoke(makeEvent(entries, PI_VCC_COMPACT_INSTRUCTION));
    // POST-FIX contract: defer (truly fall back to pi-core).
    expect(result).toBeUndefined();
  });

  test("LIE-PATH-zero-token-guard-compactAll-defers: compactAll AND low tokens → hook returns undefined (not {cancel:true})", async () => {
    // Post-fix (LD3): zero-token-guard is asymmetric — only lies in compactAll
    // scenarios. compactAll + tiny summary + empty kept tail → must defer.
    //
    // Today: returns {cancel:true} (existing before-compact-hook.test.ts asserts
    // this — that assertion will need updating in GREEN phase).
    setConfig({ debug: false, overrideDefaultCompaction: false });
    const { pi, invoke } = createMockPi();
    registerBeforeCompactHook(pi);

    // Single user + autonomous tail → buildOwnCut returns compactAll=true,
    // firstKeptEntryId="" → keptTokensEst=0 → postCompactTokens < MIN.
    const entries = [
      branchMsg("u1", "user", "go"),
      branchMsg("a1", "assistant", "calling tool"),
      branchMsg("t1", "toolResult", "result"),
      branchMsg("a2", "assistant", "done"),
    ];
    const result = await invoke(makeEvent(entries, PI_VCC_COMPACT_INSTRUCTION));
    // POST-FIX contract: defer (truly fall back to pi-core).
    expect(result).toBeUndefined();
  });

  test("LIE-PATH-zero-token-guard-nonCompactAll-unchanged: compactAll=false AND low tokens → guard does not fire (CONTROL)", async () => {
    // Control (LD3 asymmetry): zero-token-guard ONLY fires when ownCut.compactAll.
    // For compactAll=false, the guard is skipped and the hook proceeds normally
    // to return a {compaction:{...}} result.
    //
    // Must PASS today and post-fix — verifies the asymmetric guard contract.
    setConfig({ debug: false, overrideDefaultCompaction: false });
    const { pi, invoke } = createMockPi();
    registerBeforeCompactHook(pi);

    // 3+ msgs with TWO user msgs → buildOwnCut cuts at last user, compactAll=false.
    // Summary will be short, but guard doesn't fire (compactAll=false).
    const entries = [
      branchMsg("u1", "user", "first prompt"),
      branchMsg("a1", "assistant", "reply"),
      branchMsg("u2", "user", "second prompt"),
      branchMsg("a2", "assistant", "reply2"),
    ];
    const result = await invoke(makeEvent(entries, PI_VCC_COMPACT_INSTRUCTION));
    // CONTROL contract: NOT undefined (defer), NOT {cancel:true} (cancel).
    // Hook proceeds to success path.
    expect(result).toBeDefined();
    expect(result).not.toEqual({ cancel: true });
    expect((result as any)?.compaction).toBeDefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Baseline cancel paths (LD11 — no coverage today; controls PASS)
// ════════════════════════════════════════════════════════════════════════════

describe("registerBeforeCompactHook: baseline cancel paths (CONTROL)", () => {
  beforeEach(cleanupDebugArtifacts);
  afterEach(() => {
    if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
    cleanupDebugArtifacts();
  });

  test("BASELINE-no-live-messages-returns-cancel: empty branchEntries → {cancel:true}", async () => {
    // LD11: explicit no_live_messages test (no coverage today). S3/S4 keep
    // {cancel:true} for legit-empty cases — this asserts the "keep" claim.
    setConfig({ debug: false, overrideDefaultCompaction: false });
    const { pi, invoke } = createMockPi();
    registerBeforeCompactHook(pi);

    const cut = buildOwnCut([] as any);
    expect(cut.ok).toBe(false);
    if (cut.ok) return;
    expect(cut.reason).toBe("no_live_messages");

    const result = await invoke(makeEvent([], PI_VCC_COMPACT_INSTRUCTION));
    expect(result).toEqual({ cancel: true });
  });

  test("BASELINE-too-few-live-messages-returns-cancel: 1-2 live msgs → {cancel:true}", async () => {
    // LD11: explicit too_few_live_messages test (no coverage today).
    setConfig({ debug: false, overrideDefaultCompaction: false });
    const { pi, invoke } = createMockPi();
    registerBeforeCompactHook(pi);

    const entries = [
      branchComp("c1", "u1"),
      branchMsg("u1", "user", "only one"),
      branchMsg("a1", "assistant", "reply"),
    ];
    const cut = buildOwnCut(entries as any);
    expect(cut.ok).toBe(false);
    if (cut.ok) return;
    expect(cut.reason).toBe("too_few_live_messages");

    const result = await invoke(makeEvent(entries, PI_VCC_COMPACT_INSTRUCTION));
    expect(result).toEqual({ cancel: true });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Kill-switch — legacyCancelBehavior flag (LD15)
// ════════════════════════════════════════════════════════════════════════════

describe("registerBeforeCompactHook: legacyCancelBehavior kill-switch (LD15)", () => {
  beforeEach(cleanupDebugArtifacts);
  afterEach(() => {
    if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
    cleanupDebugArtifacts();
  });

  test("LEGACY-CANCEL-BEHAVIOR-flag-toggles-defer: true keeps {cancel:true}, false defers to pi-core", async () => {
    // Post-fix (LD15): legacyCancelBehavior is a kill-switch.
    //  - flag=true  → preserve OLD {cancel:true} behavior (fast rollback path)
    //  - flag=false (default) → NEW defer behavior (return undefined)
    //
    // Today: implementation ignores the flag entirely — ALWAYS returns
    // {cancel:true} for no_user_message. The flag=false assertion FAILS today.
    const entries = [
      branchComp("c1", ""),
      branchMsg("a1", "assistant", "x"),
      branchMsg("a2", "assistant", "y"),
      branchMsg("a3", "assistant", "z"),
    ];

    // ── Direction 1: flag=true preserves legacy cancel ──
    setConfig({ debug: false, overrideDefaultCompaction: false, legacyCancelBehavior: true });
    const mock1 = createMockPi();
    registerBeforeCompactHook(mock1.pi);
    const r1 = await mock1.invoke(makeEvent(entries, PI_VCC_COMPACT_INSTRUCTION));
    expect(r1).toEqual({ cancel: true });

    // ── Direction 2: flag=false (default) defers to pi-core ──
    setConfig({ debug: false, overrideDefaultCompaction: false, legacyCancelBehavior: false });
    const mock2 = createMockPi();
    registerBeforeCompactHook(mock2.pi);
    const r2 = await mock2.invoke(makeEvent(entries, PI_VCC_COMPACT_INSTRUCTION));
    expect(r2).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Defer gate on isPiVcc (LD16)
// ════════════════════════════════════════════════════════════════════════════

describe("registerBeforeCompactHook: isPiVcc defer gate (LD16)", () => {
  beforeEach(cleanupDebugArtifacts);
  afterEach(() => {
    if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
    cleanupDebugArtifacts();
  });

  test("DEFER-GATE-on-isPiVcc: explicit /pi-vcc + no_user_message surfaces toast AND defers; override=true silent path defers silently", async () => {
    // Post-fix (LD16): the Strategy-D defer MUST be gated on isPiVcc.
    //  - /pi-vcc explicit (customInstructions === __pi_vcc__) → surface error
    //    toast via ctx.ui.notify AND return undefined (user knows vcc failed)
    //  - overrideDefaultCompaction:true silent path → defer silently (graceful)
    //
    // Today: both paths return {cancel:true} for no_user_message — no defer.
    const entries = [
      branchComp("c1", ""),
      branchMsg("a1", "assistant", "x"),
      branchMsg("a2", "assistant", "y"),
      branchMsg("a3", "assistant", "z"),
    ];

    // ── Path 1: explicit /pi-vcc — must surface toast AND defer ──
    setConfig({ debug: false, overrideDefaultCompaction: false });
    const mock1 = createMockPi();
    registerBeforeCompactHook(mock1.pi);
    const r1 = await mock1.invoke(makeEvent(entries, PI_VCC_COMPACT_INSTRUCTION));
    expect(r1).toBeUndefined();
    expect(mock1.notifyCalls.length).toBeGreaterThanOrEqual(1);

    // ── Path 2: override=true silent — must defer (no special error toast) ──
    setConfig({ debug: false, overrideDefaultCompaction: true });
    const mock2 = createMockPi();
    registerBeforeCompactHook(mock2.pi);
    const r2 = await mock2.invoke(makeEvent(entries, undefined));
    expect(r2).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Observability — debug path pid-suffix (LD10) + hasLoggedCancel guard (LD17)
// ════════════════════════════════════════════════════════════════════════════

describe("registerBeforeCompactHook: debug observability (LD10, LD17)", () => {
  beforeEach(cleanupDebugArtifacts);
  afterEach(() => {
    if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
    cleanupDebugArtifacts();
  });

  test("DEBUG-PATH-includes-pid: settings.debug=true → writes /tmp/pi-vcc-debug-<pid>.json, NOT shared path", async () => {
    // Post-fix (LD10): debug snapshot path MUST include process.pid (or session
    // id) to prevent concurrent pi sessions (15+ goals + subagents + intercom)
    // from clobbering each other's writes.
    //
    // Today: hardcoded /tmp/pi-vcc-debug.json — concurrent clobbering.
    setConfig({ debug: true, overrideDefaultCompaction: false });
    const { pi, invoke } = createMockPi();
    registerBeforeCompactHook(pi);

    const entries = [
      branchMsg("a1", "assistant", "x"),
      branchMsg("a2", "assistant", "y"),
      branchMsg("a3", "assistant", "z"),
    ];
    await invoke(makeEvent(entries, PI_VCC_COMPACT_INSTRUCTION));

    // POST-FIX contract:
    expect(existsSync(debugPathPid())).toBe(true);
    expect(existsSync(DEBUG_PATH_SHARED)).toBe(false);
  });

  test("DBG-HAS-LOGGED-CANCEL-GUARD: hook called multiple times for same cancel reason → dbg file written ONCE", async () => {
    // Post-fix (LD17): dbg() must include a state.hasLoggedCancel guard so the
    // cancel event is logged exactly once per session. Today, every iteration
    // writes the file — FS sync in hot loop = heisenbug risk on stalled session.
    setConfig({ debug: true, overrideDefaultCompaction: false });
    const { pi, invoke } = createMockPi();
    registerBeforeCompactHook(pi);

    const entries = [
      branchMsg("a1", "assistant", "x"),
      branchMsg("a2", "assistant", "y"),
      branchMsg("a3", "assistant", "z"),
    ];

    // Three sequential invokes — each represents one prompt iteration on a
    // stalled session that re-enters the same cancel path.
    const event1 = makeEvent(entries, PI_VCC_COMPACT_INSTRUCTION);
    await invoke(event1);
    // Snapshot mtime of first write.
    const firstMtime = existsSync(debugPathPid())
      ? statSync(debugPathPid()).mtimeMs
      : existsSync(DEBUG_PATH_SHARED)
        ? statSync(DEBUG_PATH_SHARED).mtimeMs
        : -1;
    expect(firstMtime).toBeGreaterThan(-1); // at least one write happened

    // Force a measurable gap so mtime would change if rewritten.
    await new Promise((r) => setTimeout(r, 20));

    const event2 = makeEvent([...entries], PI_VCC_COMPACT_INSTRUCTION);
    await invoke(event2);
    const event3 = makeEvent([...entries], PI_VCC_COMPACT_INSTRUCTION);
    await invoke(event3);

    // POST-FIX contract: file was NOT rewritten on iterations 2 and 3.
    // (If today's code rewrote it, mtime would advance past firstMtime + 20ms.)
    const finalPath = existsSync(debugPathPid()) ? debugPathPid() : DEBUG_PATH_SHARED;
    const finalMtime = statSync(finalPath).mtimeMs;
    expect(finalMtime).toBe(firstMtime);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Content quality — MIN_SUMMARY_TOKENS guard (LD1 explicit user requirement)
// ════════════════════════════════════════════════════════════════════════════

describe("registerBeforeCompactHook: MIN_SUMMARY_TOKENS content-quality (LD1)", () => {
  beforeEach(cleanupDebugArtifacts);
  afterEach(() => {
    if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
    cleanupDebugArtifacts();
  });

  test("MIN-SUMMARY-TOKENS-content-check: generated summary < 200 tokens AND non-empty → defer to pi-core for quality", async () => {
    // Post-fix (LD1): user explicitly requires "the check that this compaction
    // having content in it". If the generated summary is non-empty but tiny
    // (< ~200 tokens / ~800 chars), pi-vcc should defer to pi-core default
    // compaction (LLM-based) for better quality.
    //
    // Today: no such guard — any non-empty summary is accepted, even a 1-line
    // summary of a 100k-token session. Pi-vcc "wins" via low quality.
    setConfig({ debug: false, overrideDefaultCompaction: false });
    const { pi, invoke } = createMockPi();
    registerBeforeCompactHook(pi);

    // Two user msgs (so compactAll=false, zero-token guard doesn't fire) with
    // very short content → compile returns a short summary well under ~800 chars.
    const entries = [
      branchMsg("u1", "user", "go"),
      branchMsg("a1", "assistant", "ok"),
      branchMsg("u2", "user", "stop"),
      branchMsg("a2", "assistant", "done"),
    ];
    const result = await invoke(makeEvent(entries, PI_VCC_COMPACT_INSTRUCTION));
    // POST-FIX contract: defer to pi-core for content quality.
    expect(result).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Real-session repro (LD5 — session 019f76e0)
// ════════════════════════════════════════════════════════════════════════════

describe("buildOwnCut: real-session repro (LD5 — 019f76e0)", () => {
  test("REAL-SESSION-019f76e0-repro: 1 compaction + autonomous tail + custom_message + ZERO user-role msgs → must NOT return no_user_message", () => {
    // Reproduces the structural signature of session 019f76e0 (LD5):
    //  - 1 compaction entry (firstKeptEntryId="" — prior compact-all sentinel)
    //  - 491 message entries post-compaction (mix assistant/toolResult, ZERO user)
    //  - 53 custom_message entries (pi_goal_continuation autonomous injections)
    //
    // Today: buildOwnCut's orphanRecovery collects post-compaction messages,
    // filters out custom_message, finds no user-role → no_user_message →
    // hook returns {cancel:true} → DEADLOCK (blocks progress of session).
    //
    // Scaled-down (10 asst + 10 toolResult + 3 custom_message) preserves the
    // structural signature while keeping the test fast.
    const entries: any[] = [
      branchMsg("u_orig", "user", "go"),
      branchMsg("a_orig", "assistant", "kickoff"),
      branchComp("c1", ""), // sentinel from prior compact-all
    ];
    // 10 assistant + 10 toolResult interleaved (autonomous work, no user prompts)
    for (let i = 1; i <= 10; i++) {
      entries.push(branchMsg(`a${i}`, "assistant", `autonomous step ${i}`));
      entries.push(branchMsg(`t${i}`, "toolResult", `tool output ${i}`));
    }
    // 3 custom_message entries (autonomous injections)
    entries.push(customMsg("cm1", "pi_goal_continuation", "<pi_goal_continuation>step</pi_goal_continuation>"));
    entries.push(customMsg("cm2", "pi_goal_continuation", "<pi_goal_continuation>more</pi_goal_continuation>"));
    entries.push(customMsg("cm3", "intercom", "peer msg"));

    const r = buildOwnCut(entries);
    // POST-FIX contract: must NOT deadlock on no_user_message.
    // Strategies A/B/C must resolve to ok:true (or defer at hook level).
    expect(r.ok).toBe(true);
    if (!r.ok) {
      expect(r.reason).not.toBe("no_user_message");
      return;
    }
    // And firstKeptEntryId MUST be non-empty (LD6 loop-break).
    expect(r.firstKeptEntryId).not.toBe("");
  });
});
