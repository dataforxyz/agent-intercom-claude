// Plugin monitor entry point (auto-armed by monitors/monitors.json in TUI mode).
// Tails the session's intercom inbox and prints one line per NEW inbound
// message. Claude Code's Monitor machinery injects each stdout line into the
// live session as an event the model acts on. Pre-existing backlog is skipped
// so only messages that arrive after the session starts wake it.
import { existsSync, readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { basename } from "node:path";
import { formatInboxLine, inboxBatchFrom } from "./inbox.ts";

const POLL_MS = 1000;

function readContent(path: string): string {
  try {
    return existsSync(path) ? readFileSync(path, "utf-8") : "";
  } catch {
    return "";
  }
}

export async function runInboxMonitor(path: string, signal?: { aborted: boolean }): Promise<void> {
  // Start after the current backlog so only new messages are surfaced.
  let emitted = inboxBatchFrom(readContent(path), 0).total;
  for (;;) {
    if (signal?.aborted) return;
    const { entries, total } = inboxBatchFrom(readContent(path), emitted);
    for (const entry of entries) {
      process.stdout.write(`${formatInboxLine(entry)}\n`);
    }
    emitted = total;
    await delay(POLL_MS);
  }
}

async function main(): Promise<void> {
  const path = process.env.CLAUDE_INTERCOM_INBOX || process.argv[2];
  if (!path) {
    process.stderr.write("inbox-monitor: no inbox path (set CLAUDE_INTERCOM_INBOX or pass a path)\n");
    process.exit(1);
  }
  await runInboxMonitor(path);
}

if (process.argv[1] && (basename(process.argv[1]) === "inbox-monitor.ts" || basename(process.argv[1]) === "inbox-monitor.mjs")) {
  void main().catch((error) => {
    process.stderr.write(`inbox-monitor: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
