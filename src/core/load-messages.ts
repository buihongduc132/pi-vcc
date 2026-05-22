import { readFile } from "fs/promises";
import type { Message } from "@mariozechner/pi-ai";
import { renderMessage, type RenderedEntry } from "./render-entries";

export interface ParseFailure {
  line: number;
  error: string;
  preview: string;
}

export interface LoadedMessages {
  rendered: RenderedEntry[];
  rawMessages: Message[];
  entryIds: string[];
  parseFailures: ParseFailure[];
}

export const loadAllMessages = async (
  sessionFile: string,
  full: boolean,
  allowedEntryIds?: Set<string>,
): Promise<LoadedMessages> => {
  const content = await readFile(sessionFile, "utf-8");
  const entries: any[] = [];
  const parseFailures: ParseFailure[] = [];
  let lineNum = 0;
  for (const line of content.split("\n")) {
    lineNum++;
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch (e) {
      parseFailures.push({ line: lineNum, error: (e as Error).message, preview: line.slice(0, 80) });
    }
  }

  if (parseFailures.length > 0) {
    console.warn(`[pi-vcc] Found ${parseFailures.length} JSONL parsing failures in ${sessionFile}:`);
    for (const failure of parseFailures) {
      console.warn(`  - Line ${failure.line}: ${failure.error} (starts with: "${failure.preview}...")`);
    }
  }

  const rendered: RenderedEntry[] = [];
  const rawMessages: Message[] = [];
  const entryIds: string[] = [];

  let messageIndex = 0;
  for (const e of entries) {
    const isMessage = e.type === "message" && e.message;
    if (!isMessage) continue;

    const allowed = !allowedEntryIds || allowedEntryIds.has(e.id);
    if (allowed) {
      rendered.push(renderMessage(e.message, messageIndex, full));
      rawMessages.push(e.message);
      entryIds.push(String(e.id));
    }
    messageIndex++;
  }

  return { rendered, rawMessages, entryIds, parseFailures };
};
