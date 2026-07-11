// Durable per-session inbox used by the live TUI mode (`cci --tui`).
//
// In TUI mode a single live `claude` session owns the broker identity (via the
// intercom MCP server). That MCP server appends each inbound message to this
// JSONL inbox file, and a plugin monitor tails the file and injects new lines
// into the live session. This keeps one broker connection per identity while
// still delivering unprompted wakes into an interactive session.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { getIntercomDirPath, INTERCOM_RUNTIME_FILE_MODE } from "../broker/paths.ts";
import type { Message, SessionInfo } from "../types.ts";

export interface InboxEntry {
  ts: number;
  fromId: string;
  fromName?: string;
  messageId: string;
  replyTo?: string;
  expectsReply: boolean;
  text: string;
}

export function sanitizeInboxSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "session";
}

export function defaultInboxPath(sessionId: string, intercomDir: string = getIntercomDirPath()): string {
  return join(intercomDir, `inbox-${sanitizeInboxSegment(sessionId)}.jsonl`);
}

export function toInboxEntry(from: SessionInfo, message: Message, now: number = Date.now()): InboxEntry {
  return {
    ts: now,
    fromId: from.id,
    ...(from.name ? { fromName: from.name } : {}),
    messageId: message.id,
    ...(message.replyTo ? { replyTo: message.replyTo } : {}),
    expectsReply: Boolean(message.expectsReply),
    text: message.content.text,
  };
}

export function appendInboxMessage(path: string, from: SessionInfo, message: Message): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(toInboxEntry(from, message))}\n`, {
    encoding: "utf-8",
    mode: INTERCOM_RUNTIME_FILE_MODE,
  });
}

/** Human/Claude-facing single line the monitor emits for a new inbound message. */
export function formatInboxLine(entry: InboxEntry): string {
  const who = entry.fromName ? `${entry.fromName} (${entry.fromId.slice(0, 8)})` : entry.fromId;
  const kind = entry.expectsReply ? " [asking — awaiting your reply]" : "";
  const oneLine = entry.text.replace(/\s+/g, " ").trim();
  return `Intercom message from ${who}${kind}: ${oneLine}`;
}

/**
 * Pure monitor helper: given full inbox file contents and how many lines were
 * already emitted, return the new entries plus the updated line count. Resets
 * when the file shrank (truncation/rotation).
 */
export function inboxBatchFrom(content: string, alreadyEmitted: number): { entries: InboxEntry[]; total: number } {
  const lines = content.split("\n").map((line) => line.trim()).filter(Boolean);
  const total = lines.length;
  const start = alreadyEmitted <= total ? alreadyEmitted : 0;
  const entries: InboxEntry[] = [];
  for (let index = start; index < total; index += 1) {
    try {
      entries.push(JSON.parse(lines[index]) as InboxEntry);
    } catch {
      // Skip a torn/partial line; it will be complete on the next poll.
    }
  }
  return { entries, total };
}
