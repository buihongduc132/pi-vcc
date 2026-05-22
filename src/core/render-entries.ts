import type { Message } from "@mariozechner/pi-ai";
import { clip, textOf } from "./content";
import { summarizeToolArgs } from "./tool-args";
import { extractPath } from "./tool-args";

interface BashExecutionMessage {
  role: "bashExecution";
  command?: string;
  output?: string;
}

function isBashExec(m: Message | BashExecutionMessage): m is BashExecutionMessage {
  return typeof m === "object" && m !== null && (m as unknown as Record<string, unknown>).role === "bashExecution";
}

export interface RenderedEntry {
  index: number;
  role:string;
  summary: string;
  files?: string[];
}

const toolCalls = (content: Message["content"]): string => {
  if (!content || typeof content === "string") return "";
  return content
    .filter((c) => c.type === "toolCall")
    .map((c) => `${c.name}(${summarizeToolArgs(c.arguments)})`)
    .join(", ");
};

const extractFilesFromContent = (content: Message["content"]): string[] => {
  if (!content || typeof content === "string") return [];
  return content
    .filter((c) => c.type === "toolCall")
    .map((c) => extractPath(c.arguments))
    .filter((p): p is string => p !== null);
};

export const renderMessage = (msg: Message | BashExecutionMessage, index: number, full = false): RenderedEntry => {
  if (isBashExec(msg)) {
    const cmd = msg.command ?? "";
    const out = msg.output ?? "";
    const text = full ? `$ ${cmd}\n${out}` : clip(`$ ${cmd}\n${out}`, 300);
    return { index, role: "bash", summary: text };
  }
  
  const typedMsg = msg as Message;

  if (typedMsg.role === "user") {
    return { index, role: "user", summary: full ? textOf(typedMsg.content) : clip(textOf(typedMsg.content), 300) };
  }
  if (typedMsg.role === "toolResult") {
    const prefix = typedMsg.isError ? "ERROR " : "";
    const text = full ? textOf(typedMsg.content) : clip(textOf(typedMsg.content), 200);
    return {
      index, role: "tool_result",
      summary: `${prefix}[${typedMsg.toolName}] ${text}`,
    };
  }

  const text = full ? textOf(typedMsg.content) : clip(textOf(typedMsg.content), 300);
  const tools = toolCalls(typedMsg.content);
  const files = extractFilesFromContent(typedMsg.content);
  const summary = tools ? `${tools}\n${text}` : text;
  return { index, role: "assistant", summary, ...(files.length > 0 && { files }) };
};


