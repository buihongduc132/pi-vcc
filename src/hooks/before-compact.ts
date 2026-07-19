// ════════════════════════════════════════════════════════════════════════════
// GREEN-phase implementation: no_user_message deadlock fix (LD1, LD3, LD5-LD18).
//
// Root cause (LD5, verified against real session 019f76e0): buildOwnCut filtered
// `e.type === "message"` only, so autonomous work arriving as `custom_message`
// (intercom / subagent / ACP / pi_goal_continuation) was INVISIBLE. Post-
// compaction live windows on long autonomous sessions therefore contained ZERO
// user-role messages → no_user_message → hook returned {cancel:true} → deadlock.
//
// Fix shape (locked decisions):
//   - LD5/LD18: collect custom_message + branch_summary entries into the live
//     window, treated as user-role (matches convertToLlm reclassification).
//   - LD1/LD6/LD7/LD8: layered fallback Strategy A→B→C→D in buildOwnCut.
//   - LD3: empty-summary-guard + zero-token-guard (compactAll only) are LIE
//     paths — they claimed to "fall back to pi-core" but {cancel:true} blocked
//     the fallback. Change to bare `return;` (= undefined) = true defer.
//     Keep {cancel:true} for no_live_messages + too_few_live_messages (legit
//     nothing-to-compact, per LD11). Rename dbg field `cancelled:true` →
//     `deferred:true, reason:...` on defer paths.
//   - LD15: `legacyCancelBehavior` settings flag = kill-switch. When true,
//     restore old {cancel:true} for all 3 lie paths + skip new MIN_SUMMARY guard
//     (fast rollback without redeploy). Default false.
//   - LD16: gate defer on isPiVcc. For explicit /pi-vcc failures, surface an
//     error toast AND still defer. For overrideDefaultCompaction:true silent
//     path, defer silently.
//   - LD17: dbg() cancel/defer event logged ONCE per session (existence-proxy
//     guard) — avoids FS sync in hot loop on stalled sessions.
//   - LD10: debug path uses process.pid suffix to prevent concurrent sessions
//     clobbering each other's writes.
//   - LD1 (explicit user req): MIN_SUMMARY_CHARS content-quality guard — if
//     summary is non-empty but tiny (< MIN_SUMMARY_CHARS), defer to pi-core for
//     better quality.
// ════════════════════════════════════════════════════════════════════════════

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { convertToLlm } from "@mariozechner/pi-coding-agent";
import { existsSync } from "fs";
import { writeFile } from "fs/promises";
import { compile } from "../core/summarize";
import { loadSettings, type PiVccSettings } from "../core/settings";
import type { PiVccCompactionDetails } from "../details";

interface BranchEntry {
  id: string;
  type: string;
  firstKeptEntryId?: string;
  message?: { role: string; content: unknown };
  // custom_message entries carry content at top level (not under .message).
  content?: unknown;
  // branch_summary entries carry the prior summary at top level.
  summary?: string;
}

export const PI_VCC_COMPACT_INSTRUCTION = "__pi_vcc__";

// Strategy B synth anchor id. MUST NOT match any real branch entry id, so that
// pi-core's buildSessionContext fails to resolve it → drops pre-compaction
// entries (same effect as firstKeptEntryId=""). The non-empty value satisfies
// LD6 (break-the-loop guard) without changing pi-core's empty-tail semantics.
const SYNTH_FIRST_KEPT_ID = "__pi_vcc_compact_all__";

// LD1: content-quality threshold. Summary below this is likely just boilerplate
// (RECALL_NOTE + bare transcript) without meaningful extraction → defer to
// pi-core's LLM-based compaction for better quality. Calibrated so a transcript-
// only summary (~165 chars) defers while a summary with extracted sections
// (~215 chars) succeeds. See LD1 tests in build-own-cut-strategies.test.ts.
const MIN_SUMMARY_CHARS = 200;

export interface CompactionStats {
  summarized: number;
  kept: number;
  keptTokensEst: number;
}

interface SessionState {
  stats: CompactionStats | null;
  wasPiVcc: boolean;
}
const sessionState = new WeakMap<object, SessionState>();
let currentSessionStats: CompactionStats | null = null;

export const getLastCompactionStats = () => currentSessionStats;

import { formatTokens } from "../core/format";

const UI_SETTLE_DELAY_MS = 500;

// LD10: pid-suffixed path prevents concurrent pi sessions (multiple goals +
// subagents + intercom) from clobbering each other's debug writes.
const debugPath = () => `/tmp/pi-vcc-debug-${process.pid}.json`;

// LD17: cancel/defer event logged once per session. Existence-proxy guard — if
// the debug file was removed (new session / test reset), reset the flag so the
// next event still writes. Avoids FS sync in the hot loop on stalled sessions
// where the hook re-enters the same cancel path every prompt iteration.
let hasLoggedCancel = false;

const dbg = async (settings: PiVccSettings, data: Record<string, unknown>) => {
  if (!settings.debug) return;
  const isCancelDefer = data.deferred === true || data.cancelled === true;
  if (isCancelDefer) {
    if (!existsSync(debugPath())) hasLoggedCancel = false;
    if (hasLoggedCancel) return;
    hasLoggedCancel = true;
  }
  try {
    await writeFile(debugPath(), JSON.stringify(data, null, 2));
  } catch (e) {
    // Intentional fallback: debug logging is best-effort and should not crash compaction.
  }
};

const previewContent = (content: unknown): string => {
  if (typeof content === "string") return content.slice(0, 300);
  if (Array.isArray(content)) {
    return content
      .map((c: any) => {
        if (c?.type === "text") return c.text ?? "";
        if (c?.type === "toolCall") return `[toolCall:${c.name}]`;
        if (c?.type === "thinking") return `[thinking]`;
        if (c?.type === "image") return `[image:${c.mimeType}]`;
        return `[${c?.type ?? "unknown"}]`;
      })
      .join("\n")
      .slice(0, 300);
  }
  return "";
};

interface EntryWithMessage {
  entry: { id: string; type: string };
  message: { role: string; content: unknown };
}

/**
 * Collect an entry into the live window. Per LD5/LD18, custom_message and
 * branch_summary entries are included (treated as role:"user" since
 * convertToLlm reclassifies them as user anyway). This is the structural fix
 * that makes autonomous-only live windows visible to vcc.
 */
const collectEntry = (e: BranchEntry): EntryWithMessage | null => {
  if (e.type === "message" && e.message) {
    return { entry: e, message: e.message };
  }
  if (e.type === "custom_message") {
    // LD18: convertToLlm case "custom" → role:"user".
    const content = typeof e.content === "string" ? e.content : e.content ?? "";
    return { entry: e, message: { role: "user", content } };
  }
  if (e.type === "branch_summary") {
    // LD18: convertToLlm case "branchSummary" → role:"user" with prefix.
    const text = e.summary ?? "";
    return {
      entry: e,
      message: { role: "user", content: [{ type: "text", text }] },
    };
  }
  return null;
};

export type OwnCutCancelReason = "no_live_messages" | "too_few_live_messages" | "no_user_message";

export type OwnCutResult =
  | { ok: true; messages: any[]; firstKeptEntryId: string; compactAll: boolean }
  | { ok: false; reason: OwnCutCancelReason };

export function buildOwnCut(branchEntries: BranchEntry[]): OwnCutResult {
  // Find the last compaction entry and its firstKeptEntryId
  let lastCompactionIdx = -1;
  let lastKeptId: string | undefined;
  for (let i = branchEntries.length - 1; i >= 0; i--) {
    if (branchEntries[i].type === "compaction") {
      lastCompactionIdx = i;
      lastKeptId = branchEntries[i].firstKeptEntryId;
      break;
    }
  }

  // Orphan recovery: triggers when lastKeptId is set to "" (sentinel from prior
  // compact-all) OR set to an id that no longer exists in the branch. In both cases,
  // start collecting from right after the last compaction entry.
  const hasPriorCompaction = lastCompactionIdx >= 0;
  const hasValidKeptId = !!lastKeptId && branchEntries.some((e) => e.id === lastKeptId);
  const orphanRecovery = hasPriorCompaction && !hasValidKeptId;

  // Collect live messages — now including custom_message + branch_summary (LD5).
  const liveMessages: EntryWithMessage[] = [];
  if (orphanRecovery) {
    for (let i = lastCompactionIdx + 1; i < branchEntries.length; i++) {
      const e = branchEntries[i];
      if (e.type === "compaction") continue;
      const wm = collectEntry(e);
      if (wm) liveMessages.push(wm);
    }
  } else {
    let foundKept = !lastKeptId; // if no prior compaction, start collecting immediately
    for (const e of branchEntries) {
      if (!foundKept && e.id === lastKeptId) foundKept = true;
      if (!foundKept) continue;
      if (e.type === "compaction") continue;
      const wm = collectEntry(e);
      if (wm) liveMessages.push(wm);
    }
  }

  if (liveMessages.length === 0) return { ok: false, reason: "no_live_messages" };
  if (liveMessages.length <= 2) return { ok: false, reason: "too_few_live_messages" };

  // ── Strategy A: walk back to last user-role entry ──
  // (now includes custom_message + branch_summary treated as user per LD5)
  let cutIdx = liveMessages.length - 1;
  while (cutIdx > 0 && liveMessages[cutIdx].message.role !== "user") {
    cutIdx--;
  }

  if (cutIdx > 0) {
    return {
      ok: true,
      messages: liveMessages.slice(0, cutIdx).map((e) => e.message),
      firstKeptEntryId: liveMessages[cutIdx].entry.id,
      compactAll: false,
    };
  }

  // cutIdx === 0 — first entry of live window is user-role (or no user at all).
  const firstIsUser = liveMessages[0].message.role === "user";
  if (firstIsUser) {
    const isRealUser = liveMessages[0].entry.type === "message";
    if (!isRealUser) {
      // ── Strategy B: synth user from prior compaction summary ──
      // live[0] is branch_summary / custom_message acting as the user anchor.
      // LD6: return NON-EMPTY firstKeptEntryId that does NOT match any real
      // branch entry → pi-core drops pre-compaction entries (same effect as "")
      // → next compaction's orphan recovery finds an empty live window → no
      // infinite loop. The synth id is also distinct from "" so hook-layer
      // guards that check truthiness still work.
      return {
        ok: true,
        messages: liveMessages.map((e) => e.message),
        firstKeptEntryId: SYNTH_FIRST_KEPT_ID,
        compactAll: true,
      };
    }

    // Real type=message user at live[0]. LD7: if the live window ENDS in a
    // toolResult, compactAll="" would keep the trailing orphan toolResult in
    // the kept tail (LLM API errors). Walk back to the nearest non-toolResult
    // entry instead and cut there.
    const endsInToolResult = liveMessages[liveMessages.length - 1].message.role === "toolResult";
    if (endsInToolResult) {
      for (let i = liveMessages.length - 1; i >= 0; i--) {
        if (liveMessages[i].message.role !== "toolResult") {
          // Cutting AT this entry keeps it + the trailing toolResult(s). If this
          // entry is itself a toolCall-bearing assistant, the pairing is valid.
          // If it's the user, the trailing toolResult is orphaned anyway — but
          // firstKeptEntryId pointing at a real entry satisfies the LD7 contract.
          if (i === 0) break; // would be compactAll; handled below
          return {
            ok: true,
            messages: liveMessages.slice(0, i).map((e) => e.message),
            firstKeptEntryId: liveMessages[i].entry.id,
            compactAll: false,
          };
        }
      }
    }

    // Legit single-user scenario — compact everything, keep no tail.
    // firstKeptEntryId="" is a sentinel: pi-core's buildSessionContext won't
    // match it (so 0 kept from pre-compaction), and next buildOwnCut triggers
    // orphan recovery.
    return {
      ok: true,
      messages: liveMessages.map((e) => e.message),
      firstKeptEntryId: "",
      compactAll: true,
    };
  }

  // ── No user-role anywhere in the live window. ──

  // Strategy C: if there are assistant entries AND toolResult entries, cut at
  // the last assistant entry. Per LD7, never cut AT a toolResult (would orphan
  // the preceding toolCall). The presence of toolResult indicates autonomous
  // work-in-progress that benefits from keeping the last assistant as context.
  // Pure-assistant live windows (no toolResult) fall through to Strategy D —
  // this preserves the existing "no_user_message when no user role at all"
  // contract for the all-assistant chit-chat case.
  const hasToolResult = liveMessages.some((m) => m.message.role === "toolResult");
  if (hasToolResult) {
    for (let i = liveMessages.length - 1; i >= 0; i--) {
      if (liveMessages[i].message.role === "assistant") {
        return {
          ok: true,
          messages: liveMessages.slice(0, i).map((e) => e.message),
          firstKeptEntryId: liveMessages[i].entry.id,
          compactAll: false,
        };
      }
    }
  }

  // ── Strategy D: no user, no assistant with toolResult context (e.g. all
  // toolResult, or pure assistant with no toolResult). Defer to pi-core. The
  // hook layer returns bare `undefined;` per LD8 so pi-core's default
  // compaction runs.
  return { ok: false, reason: "no_user_message" };
}

const REASON_MESSAGES: Record<OwnCutCancelReason, string> = {
  no_live_messages: "pi-vcc: Nothing to compact (no live messages)",
  too_few_live_messages: "pi-vcc: Too few messages to compact",
  no_user_message: "pi-vcc: Cannot compact — no user message found",
};

// Reasons that defer to pi-core (LD3 lie paths). Legit-empty reasons
// (no_live_messages, too_few_live_messages) keep {cancel:true} per LD11.
const DEFER_REASONS: ReadonlySet<OwnCutCancelReason> = new Set(["no_user_message"]);

// LD16: explicit /pi-vcc failure surfaces an error toast so the user knows vcc
// failed (silent defer would be a user-intent violation). overrideDefaultCompaction
// silent path defers silently (graceful degradation).
const PI_VCC_FAIL_TOAST = "pi-vcc: failed — pi-core default compaction ran instead";

export const registerBeforeCompactHook = (pi: ExtensionAPI) => {
  pi.on("session_before_compact", async (event, ctx) => {
    const { preparation, branchEntries, customInstructions } = event;
    const settings = await loadSettings();

    let state = sessionState.get(event);
    if (!state) {
      state = { stats: null, wasPiVcc: false };
      sessionState.set(event, state);
    }

    // Always handle explicit /pi-vcc marker.
    // Otherwise, only handle when user opted in via settings.
    const isPiVcc = customInstructions === PI_VCC_COMPACT_INSTRUCTION;
    if (!isPiVcc && !settings.overrideDefaultCompaction) return;

    const typedBranchEntries = branchEntries as BranchEntry[];
    const ownCut = buildOwnCut(typedBranchEntries);

    // Helper: defer to pi-core. Bare `return;` (= undefined) is the canonical
    // "no-op hook → pi-core default" signal per LD8. NOT `return {}` (unspecified).
    // Per LD16, /pi-vcc failures surface an error toast; silent path does not.
    const deferToPiCore = async (reason: string, snapshot: Record<string, unknown>) => {
      await dbg(settings, { deferred: true, reason, isPiVcc, ...snapshot });
      if (isPiVcc) {
        try {
          ctx?.ui?.notify?.(PI_VCC_FAIL_TOAST, "error");
        } catch (e) {
          // Intentional fallback: UI notifications are best-effort.
        }
      }
      return;
    };

    if (!ownCut.ok) {
      const lastComp = [...typedBranchEntries].reverse().find((e) => e.type === "compaction");
      const lastCompIdx = lastComp ? typedBranchEntries.indexOf(lastComp) : -1;

      // Recompute liveMessages view (same logic as buildOwnCut) for diagnostic
      const lastKeptId: string | undefined = lastComp?.firstKeptEntryId;
      const hasPriorCompaction = lastCompIdx >= 0;
      const hasValidKeptId = !!lastKeptId && typedBranchEntries.some((e) => e.id === lastKeptId);
      const diagOrphan = hasPriorCompaction && !hasValidKeptId;
      const liveRoles: string[] = [];
      const collectDiag = (e: BranchEntry) => {
        if (e.type === "compaction") return;
        const wm = collectEntry(e);
        if (wm) liveRoles.push(wm.message.role);
      };
      if (diagOrphan) {
        for (let i = lastCompIdx + 1; i < typedBranchEntries.length; i++) {
          collectDiag(typedBranchEntries[i]);
        }
      } else {
        let foundKept = !lastKeptId;
        for (const e of typedBranchEntries) {
          if (!foundKept && e.id === lastKeptId) foundKept = true;
          if (!foundKept) continue;
          collectDiag(e);
        }
      }
      const userIndices = liveRoles.reduce<number[]>((acc, r, i) => (r === "user" ? (acc.push(i), acc) : acc), []);

      const snapshot = {
        counts: {
          total: typedBranchEntries.length,
          messages: typedBranchEntries.filter((e) => e.type === "message").length,
          customMessages: typedBranchEntries.filter((e) => e.type === "custom_message").length,
          branchSummaries: typedBranchEntries.filter((e) => e.type === "branch_summary").length,
          compactions: typedBranchEntries.filter((e) => e.type === "compaction").length,
          entriesAfterLastCompaction: lastCompIdx >= 0 ? typedBranchEntries.length - lastCompIdx - 1 : null,
        },
        liveMessages: {
          count: liveRoles.length,
          userCount: userIndices.length,
          firstUserIdx: userIndices[0] ?? null,
          lastUserIdx: userIndices[userIndices.length - 1] ?? null,
          roleSequence:
            liveRoles.length <= 30 ? liveRoles : [...liveRoles.slice(0, 10), "...", ...liveRoles.slice(-10)],
        },
        lastCompaction: lastComp
          ? {
              hasFirstKeptEntryId: !!lastComp.firstKeptEntryId,
              foundInBranch: lastComp.firstKeptEntryId
                ? typedBranchEntries.some((e) => e.id === lastComp.firstKeptEntryId)
                : null,
            }
          : null,
        tail: typedBranchEntries.slice(-5).map((e) => ({
          type: e.type,
          role: e.type === "message" ? e.message?.role : undefined,
          hasContent: e.type === "message" ? e.message?.content != null : undefined,
        })),
        legacyCancelBehavior: settings.legacyCancelBehavior,
      };

      const isDeferReason = DEFER_REASONS.has(ownCut.reason);

      if (isDeferReason && !settings.legacyCancelBehavior) {
        // LD3/LD8/LD15/LD16: no_user_message is a LIE path. Defer to pi-core.
        return deferToPiCore(ownCut.reason, snapshot);
      }

      // Legit-empty (no_live_messages, too_few_live_messages) per LD11, OR
      // legacyCancelBehavior kill-switch per LD15 → preserve {cancel:true}.
      await dbg(settings, { cancelled: true, reason: ownCut.reason, isPiVcc, ...snapshot });
      try {
        ctx?.ui?.notify?.(REASON_MESSAGES[ownCut.reason], "warning");
      } catch (e) {
        // Intentional fallback: UI notifications are best-effort.
      }
      return { cancel: true };
    }

    const agentMessages = ownCut.messages;
    const firstKeptEntryId = ownCut.firstKeptEntryId;
    const messages = convertToLlm(agentMessages);

    // Count kept messages and estimate tokens
    // SYNTH_FIRST_KEPT_ID and "" both resolve to keptIdx=-1 (non-matching) →
    // empty kept tail, which is the compactAll intent.
    const keptIdx = typedBranchEntries.findIndex((e) => e.id === firstKeptEntryId);
    const keptEntries =
      keptIdx >= 0 ? typedBranchEntries.slice(keptIdx).filter((e) => e.type === "message") : [];
    const keptChars = keptEntries.reduce((sum: number, e: BranchEntry) => {
      const c = e.message?.content;
      if (typeof c === "string") return sum + c.length;
      if (Array.isArray(c))
        return (
          sum +
          c.reduce((s: number, p: any) => {
            if (p.text) return s + p.text.length;
            if (p.type === "toolCall")
              return (
                s +
                (p.name?.length ?? 0) +
                (typeof p.input === "string" ? p.input.length : JSON.stringify(p.input ?? "").length)
              );
            if (p.type === "toolResult")
              return (
                s +
                (typeof p.content === "string" ? p.content.length : JSON.stringify(p.content ?? "").length)
              );
            return s;
          }, 0)
        );
      return sum;
    }, 0);
    state.stats = {
      summarized: agentMessages.length,
      kept: keptEntries.length,
      keptTokensEst: Math.round(keptChars / 4),
    };
    currentSessionStats = state.stats;

    const config = settings;

    const summary = await compile({
      messages,
      previousSummary: preparation.previousSummary,
      fileOps: {
        readFiles: [...preparation.fileOps.read],
        modifiedFiles: [...preparation.fileOps.written, ...preparation.fileOps.edited],
      },
    });

    // ── Guard: empty summary (edge-case #16) ──
    // LD3: LIE path. Was {cancel:true} (blocked fallback). Now defers via bare
    // `return;` so pi-core's default compaction actually runs.
    if (!summary || !summary.trim()) {
      if (settings.legacyCancelBehavior) {
        await dbg(settings, {
          cancelled: true,
          reason: "empty-summary-guard",
          isPiVcc,
          summaryLength: summary?.length ?? 0,
          legacyCancelBehavior: true,
        });
        try {
          ctx?.ui?.notify?.(
            "pi-vcc: Compaction summary is empty. Cancelling — falling back to pi-core default compaction.",
            "warning",
          );
        } catch (e) {
          // Intentional fallback: UI notifications are best-effort.
        }
        return { cancel: true };
      }
      return deferToPiCore("empty-summary-guard", {
        summaryLength: summary?.length ?? 0,
      });
    }

    // ── Guard: zero-token post-compaction result (edge-case #16) ──
    // LD3 asymmetric: only lies in compactAll scenarios. compactAll=false keeps
    // existing behavior (the guard is skipped entirely).
    const MIN_POST_COMPACTION_TOKENS = 4096;
    const summaryTokensEst = Math.round(summary.length / 4);
    const postCompactTokensEst = (state.stats.keptTokensEst ?? 0) + summaryTokensEst;
    if (postCompactTokensEst < MIN_POST_COMPACTION_TOKENS && ownCut.compactAll) {
      if (settings.legacyCancelBehavior) {
        await dbg(settings, {
          cancelled: true,
          reason: "zero-token-guard",
          isPiVcc,
          postCompactTokensEst,
          keptTokensEst: state.stats.keptTokensEst,
          summaryTokensEst,
          MIN_POST_COMPACTION_TOKENS,
          compactAll: ownCut.compactAll,
          legacyCancelBehavior: true,
        });
        try {
          ctx?.ui?.notify?.(
            `pi-vcc: Post-compaction context would be ~${postCompactTokensEst} tokens (min ${MIN_POST_COMPACTION_TOKENS}). ` +
              "Cancelling — falling back to pi-core default compaction.",
            "warning",
          );
        } catch (e) {
          // Intentional fallback: UI notifications are best-effort.
        }
        return { cancel: true };
      }
      return deferToPiCore("zero-token-guard", {
        postCompactTokensEst,
        keptTokensEst: state.stats.keptTokensEst,
        summaryTokensEst,
        MIN_POST_COMPACTION_TOKENS,
        compactAll: ownCut.compactAll,
      });
    }

    // ── LD1: MIN_SUMMARY_CHARS content-quality guard ──
    // Non-empty but tiny summary → likely just boilerplate/RECALL_NOTE without
    // meaningful extraction. Defer to pi-core's LLM-based compaction for better
    // quality. Skipped when legacyCancelBehavior=true (kill-switch rolls back ALL
    // new behavior, including this new guard).
    if (!settings.legacyCancelBehavior && summary.length < MIN_SUMMARY_CHARS) {
      return deferToPiCore("min-summary-tokens", {
        summaryLength: summary.length,
        MIN_SUMMARY_CHARS,
      });
    }

    const branchIds = typedBranchEntries.map((e) => e.id);
    const cutIdx = branchIds.indexOf(firstKeptEntryId);
    const cutWindow =
      cutIdx >= 0
        ? typedBranchEntries.slice(Math.max(0, cutIdx - 3), Math.min(branchEntries.length, cutIdx + 3)).map((e) => ({
            id: e.id,
            type: e.type,
            role: e.type === "message" ? e.message?.role : undefined,
            preview: e.type === "message" ? previewContent(e.message?.content) : undefined,
          }))
        : [];

    await dbg(config, {
      usedOwnCut: true,
      messagesToSummarize: agentMessages.length,
      messagesPreviewHead: agentMessages
        .slice(0, 3)
        .map((m: any) => ({ role: m.role, preview: previewContent(m.content) })),
      messagesPreviewTail: agentMessages
        .slice(-3)
        .map((m: any) => ({ role: m.role, preview: previewContent(m.content) })),
      convertedMessages: messages.length,
      firstKeptEntryId,
      cutWindow,
      tokensBefore: preparation.tokensBefore,
      summaryLength: summary.length,
      summaryPreview: summary.slice(0, 500),
      sections: [...summary.matchAll(/^\[(.+?)\]/gm)].map((m) => m[1]),
    });

    const details: PiVccCompactionDetails = {
      compactor: "pi-vcc",
      version: 1,
      sections: [...summary.matchAll(/^\[(.+?)\]/gm)].map((m) => m[1]),
      sourceMessageCount: agentMessages.length,
      previousSummaryUsed: Boolean(preparation.previousSummary),
    };

    state.wasPiVcc = isPiVcc;

    return {
      compaction: {
        summary,
        details,
        tokensBefore: preparation.tokensBefore,
        firstKeptEntryId,
      },
    };
  });

  // Fire success toast for /compact path only (delayed to let UI settle).
  // /pi-vcc path uses its own onComplete callback in the command handler.
  pi.on("session_compact", (event, ctx) => {
    const state = sessionState.get(event);
    if (!event.fromExtension) return;
    if (state?.wasPiVcc) return; // /pi-vcc handles its own toast via onComplete
    const stats = state?.stats;
    if (!stats) return;
    setTimeout(() => {
      try {
        ctx?.ui?.notify?.(
          `pi-vcc: ${stats.summarized} source entries processed; tail kept ${
            stats.kept
          } (~${formatTokens(stats.keptTokensEst)} tok).`,
          "info",
        );
      } catch (e) {
        // Intentional fallback: UI notifications are best-effort and should not crash the compaction.
      }
    }, UI_SETTLE_DELAY_MS);
  });
};
