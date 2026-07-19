import type { Message } from "@mariozechner/pi-ai";

const ts = Date.now();
const assistBase = {
  api: "messages" as any,
  provider: "anthropic" as any,
  model: "test",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  timestamp: ts,
};

export const userMsg = (text: string): Message => ({
  role: "user",
  content: text,
  timestamp: ts,
});

export const assistantText = (text: string): Message => ({
  role: "assistant",
  content: [{ type: "text", text }],
  ...assistBase,
  stopReason: "stop",
});

export const assistantWithThinking = (
  text: string,
  thinking: string,
): Message => ({
  role: "assistant",
  content: [
    { type: "thinking", thinking },
    { type: "text", text },
  ],
  ...assistBase,
  stopReason: "stop",
});

export const assistantWithToolCall = (
  name: string,
  args: Record<string, unknown>,
): Message => ({
  role: "assistant",
  content: [{ type: "toolCall", id: "tc_1", name, arguments: args }],
  ...assistBase,
  stopReason: "toolUse",
});

export const toolResult = (
  name: string,
  text: string,
  isError = false,
): Message => ({
  role: "toolResult",
  toolCallId: "tc_1",
  toolName: name,
  content: [{ type: "text", text }],
  isError,
  timestamp: ts,
});

// ── Branch-entry fixtures (for buildOwnCut tests) ─────────────────────────────
// These mirror pi-core SessionEntry shapes that reach the before-compact hook.

/**
 * custom_message entry — autonomous work injection (intercom / subagent / ACP /
 * pi_goal_continuation). Top-level type="custom_message" (NOT type=message).
 * Per LD18, convertToLlm reclassifies these to role:"user" — but buildOwnCut's
 * `e.type==='message'` filter is blind to them today (the structural bug).
 */
export const customMsg = (
  id: string,
  customType: string,
  content: unknown,
): Record<string, unknown> => ({
  id,
  type: "custom_message",
  customType,
  content,
  display: true,
  timestamp: ts,
});

/**
 * branch_summary entry — prior compaction's summary surfacing as a branch-level
 * entry. Per LD18, convertToLlm maps to role:"user" (case "branchSummary").
 * Strategy B synth-from-prior-summary relies on this shape.
 */
export const branchSummaryMsg = (
  id: string,
  summary: string,
): Record<string, unknown> => ({
  id,
  type: "branch_summary",
  summary,
  timestamp: ts,
});

/**
 * bashExecution-role message entry — the ONLY non-conversational role that still
 * rides on type=message entries (so it slips past the current buildOwnCut filter
 * but should be reclassified as user-action per LD12/OT2).
 */
export const bashExecMsg = (
  id: string,
  content: string,
): Record<string, unknown> => ({
  id,
  type: "message",
  message: {
    role: "bashExecution",
    content: [{ type: "text", text: content }],
  },
});

// Standard message entry helper (mirrors before-compact.test.ts msg()) so strategy
// tests can mix custom_message + message entries in one branchEntries array.
export const branchMsg = (
  id: string,
  role: "user" | "assistant" | "toolResult",
  content: unknown = "x",
): Record<string, unknown> => ({
  id,
  type: "message",
  message: { role, content },
});

export const branchComp = (
  id: string,
  firstKeptEntryId?: string,
): Record<string, unknown> => ({
  id,
  type: "compaction",
  firstKeptEntryId,
});

