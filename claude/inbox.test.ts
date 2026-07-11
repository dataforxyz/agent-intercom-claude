import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendInboxMessage,
  defaultInboxPath,
  formatInboxLine,
  inboxBatchFrom,
  sanitizeInboxSegment,
  toInboxEntry,
  type InboxEntry,
} from "./inbox.ts";
import type { Message, SessionInfo } from "../types.ts";

const from: SessionInfo = {
  id: "abcd1234ef", name: "planner", cwd: "/tmp/p", model: "claude",
  pid: 1, startedAt: 0, lastActivity: 0,
};
function msg(text: string, expectsReply = false): Message {
  return { id: "m1", timestamp: 0, expectsReply, content: { text } };
}

test("toInboxEntry captures sender, ask flag, and text", () => {
  const entry = toInboxEntry(from, msg("hello there", true), 42);
  assert.equal(entry.fromId, "abcd1234ef");
  assert.equal(entry.fromName, "planner");
  assert.equal(entry.expectsReply, true);
  assert.equal(entry.text, "hello there");
  assert.equal(entry.ts, 42);
});

test("formatInboxLine marks asks and collapses whitespace", () => {
  const ask = formatInboxLine(toInboxEntry(from, msg("line1\n  line2", true)));
  assert.match(ask, /Intercom message from planner \(abcd1234\) \[asking — awaiting your reply\]: line1 line2/);
  const note = formatInboxLine(toInboxEntry(from, msg("fyi")));
  assert.match(note, /Intercom message from planner \(abcd1234\): fyi/);
  assert.doesNotMatch(note, /asking/);
});

test("formatInboxLine falls back to id when unnamed", () => {
  const anon: SessionInfo = { ...from, name: undefined };
  assert.match(formatInboxLine(toInboxEntry(anon, msg("x"))), /Intercom message from abcd1234ef: x/);
});

test("inboxBatchFrom skips already-emitted lines and returns new entries", () => {
  const line = (t: string) => JSON.stringify({ ts: 0, fromId: "z", messageId: t, expectsReply: false, text: t } satisfies InboxEntry);
  const content = `${line("a")}\n${line("b")}\n${line("c")}\n`;
  const first = inboxBatchFrom(content, 0);
  assert.equal(first.total, 3);
  assert.deepEqual(first.entries.map((e) => e.text), ["a", "b", "c"]);
  const next = inboxBatchFrom(content, 3);
  assert.equal(next.entries.length, 0);
  assert.equal(next.total, 3);
  const partial = inboxBatchFrom(content, 1);
  assert.deepEqual(partial.entries.map((e) => e.text), ["b", "c"]);
});

test("inboxBatchFrom resets when the file shrank (rotation/truncation)", () => {
  const line = JSON.stringify({ ts: 0, fromId: "z", messageId: "a", expectsReply: false, text: "a" } satisfies InboxEntry);
  const batch = inboxBatchFrom(`${line}\n`, 5); // previously saw 5 lines, now only 1 -> reset
  assert.equal(batch.total, 1);
  assert.deepEqual(batch.entries.map((e) => e.text), ["a"]);
});

test("inboxBatchFrom ignores torn/partial trailing JSON", () => {
  const good = JSON.stringify({ ts: 0, fromId: "z", messageId: "a", expectsReply: false, text: "a" } satisfies InboxEntry);
  const batch = inboxBatchFrom(`${good}\n{"partial":`, 0);
  assert.deepEqual(batch.entries.map((e) => e.text), ["a"]);
});

test("appendInboxMessage writes a JSONL round-trip", () => {
  const dir = mkdtempSync(join(tmpdir(), "cci-inbox-"));
  const path = join(dir, "inbox.jsonl");
  appendInboxMessage(path, from, msg("first", true));
  appendInboxMessage(path, from, msg("second"));
  const { entries, total } = inboxBatchFrom(readFileSync(path, "utf-8"), 0);
  assert.equal(total, 2);
  assert.deepEqual(entries.map((e) => e.text), ["first", "second"]);
  assert.equal(entries[0].expectsReply, true);
  assert.equal(entries[1].expectsReply, false);
});

test("defaultInboxPath and sanitizeInboxSegment produce a safe filename", () => {
  assert.equal(sanitizeInboxSegment("Worker/A:1"), "worker-a-1");
  assert.match(defaultInboxPath("worker-a"), /inbox-worker-a\.jsonl$/);
});
