import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { convertToLlm } from "@mariozechner/pi-coding-agent";
import { writeFile } from "fs/promises";
import { compile } from "../core/summarize";
import { loadSettings, type PiVccSettings } from "../core/settings";
import type { PiVccCompactionDetails } from "../details";

interface BranchEntry {
  id: string;
  type: string;
  firstKeptEntryId?: string;
  message?: { role: string; content: unknown };
}

export const PI_VCC_COMPACT_INSTRUCTION = "__pi_vcc__";

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

const dbg = async (settings: PiVccSettings, data: Record<string, unknown>) => {
  if (!settings.debug) return;
  try {
    await writeFile("/tmp/pi-vcc-debug.json", JSON.stringify(data, null, 2));
  } catch (e) {
    // Intentional fallback: UI notifications are best-effort and should not crash the compaction.
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

  // Collect live messages
  const liveMessages: EntryWithMessage[] = [];
  if (orphanRecovery) {
    for (let i = lastCompactionIdx + 1; i < branchEntries.length; i++) {
      const e = branchEntries[i];
      if (e.type === "compaction") continue;
      if (e.type === "message" && e.message) {
        liveMessages.push({ entry: e, message: e.message });
      }
    }
  } else {
    let foundKept = !lastKeptId; // if no prior compaction, start collecting immediately
    for (const e of branchEntries) {
      if (!foundKept && e.id === lastKeptId) foundKept = true;
      if (!foundKept) continue;
      if (e.type === "compaction") continue;
      if (e.type === "message" && e.message) {
        liveMessages.push({ entry: e, message: e.message });
      }
    }
  }

  if (liveMessages.length === 0) return { ok: false, reason: "no_live_messages" };
  if (liveMessages.length <= 2) return { ok: false, reason: "too_few_live_messages" };

  // Summarize all messages, keep only the last user message as context
  let cutIdx = liveMessages.length - 1;
  while (cutIdx > 0 && liveMessages[cutIdx].message.role !== "user") {
    cutIdx--;
  }

  if (cutIdx <= 0) {
    // Single user prompt scenario (or no user at all).
    // If there's at least one user message, compact EVERYTHING and keep no tail.
    // firstKeptEntryId="" is a sentinel: pi-core's buildSessionContext won't match it
    // (so 0 kept from pre-compaction), and next buildOwnCut triggers orphan recovery.
    const hasUser = liveMessages.some((m) => m.message.role === "user");
    if (!hasUser) return { ok: false, reason: "no_user_message" };
    return {
      ok: true,
      messages: liveMessages.map((e) => e.message),
      firstKeptEntryId: "",
      compactAll: true,
    };
  }

  return {
    ok: true,
    messages: liveMessages.slice(0, cutIdx).map((e) => e.message),
    firstKeptEntryId: liveMessages[cutIdx].entry.id,
    compactAll: false,
  };
}

const REASON_MESSAGES: Record<OwnCutCancelReason, string> = {
  no_live_messages: "pi-vcc: Nothing to compact (no live messages)",
  too_few_live_messages: "pi-vcc: Too few messages to compact",
  no_user_message: "pi-vcc: Cannot compact — no user message found",
};

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
    if (!ownCut.ok) {
      const lastComp = [...typedBranchEntries].reverse().find((e) => e.type === "compaction");
      const lastCompIdx = lastComp ? typedBranchEntries.indexOf(lastComp) : -1;

      // Recompute liveMessages view (same logic as buildOwnCut) for diagnostic
      const lastKeptId: string | undefined = lastComp?.firstKeptEntryId;
      const hasPriorCompaction = lastCompIdx >= 0;
      const hasValidKeptId = !!lastKeptId && typedBranchEntries.some((e) => e.id === lastKeptId);
      const diagOrphan = hasPriorCompaction && !hasValidKeptId;
      const liveRoles: string[] = [];
      if (diagOrphan) {
        for (let i = lastCompIdx + 1; i < typedBranchEntries.length; i++) {
          const e = typedBranchEntries[i];
          if (e.type === "compaction") continue;
          if (e.type === "message" && e.message) liveRoles.push(e.message.role);
        }
      } else {
        let foundKept = !lastKeptId;
        for (const e of typedBranchEntries) {
          if (!foundKept && e.id === lastKeptId) foundKept = true;
          if (!foundKept) continue;
          if (e.type === "compaction") continue;
          if (e.type === "message" && e.message) liveRoles.push(e.message.role);
        }
      }
      const userIndices = liveRoles.reduce<number[]>((acc, r, i) => (r === "user" ? (acc.push(i), acc) : acc), []);

      await dbg(settings, {
        cancelled: true,
        reason: ownCut.reason,
        isPiVcc,
        counts: {
          total: typedBranchEntries.length,
          messages: typedBranchEntries.filter((e) => e.type === "message").length,
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
      });

      try {
        ctx?.ui?.notify?.(REASON_MESSAGES[ownCut.reason], "warning");
      } catch (e) {
        // Intentional fallback: UI notifications are best-effort and should not crash the compaction.
      }
      return { cancel: true };
    }

    const agentMessages = ownCut.messages;
    const firstKeptEntryId = ownCut.firstKeptEntryId;
    const messages = convertToLlm(agentMessages);

    // Count kept messages and estimate tokens
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
    if (!summary || !summary.trim()) {
      await dbg(settings, {
        cancelled: true,
        reason: "empty-summary-guard",
        summaryLength: summary?.length ?? 0,
      });
      try {
        ctx?.ui?.notify?.(
          "pi-vcc: Compaction summary is empty. Cancelling — falling back to pi-core default compaction.",
          "warning",
        );
      } catch (e) {
        // Intentional fallback: UI notifications are best-effort and should not crash the compaction.
      }
      return { cancel: true };
    }

    // ── Guard: zero-token post-compaction result (edge-case #16) ──
    // If compaction would leave zero or near-zero context, cancel and let
    // pi-core default compaction handle it (which keeps keepRecentTokens).
    const MIN_POST_COMPACTION_TOKENS = 4096;
    const summaryTokensEst = Math.round(summary.length / 4);
    const postCompactTokensEst = (state.stats.keptTokensEst ?? 0) + summaryTokensEst;
    if (postCompactTokensEst < MIN_POST_COMPACTION_TOKENS && ownCut.compactAll) {
      await dbg(settings, {
        cancelled: true,
        reason: "zero-token-guard",
        postCompactTokensEst,
        keptTokensEst: state.stats.keptTokensEst,
        summaryTokensEst,
        MIN_POST_COMPACTION_TOKENS,
        compactAll: ownCut.compactAll,
      });
      try {
        ctx?.ui?.notify?.(
          `pi-vcc: Post-compaction context would be ~${postCompactTokensEst} tokens (min ${MIN_POST_COMPACTION_TOKENS}). ` +
            "Cancelling — falling back to pi-core default compaction.",
          "warning",
        );
      } catch (e) {
        // Intentional fallback: UI notifications are best-effort and should not crash the compaction.
      }
      return { cancel: true };
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
