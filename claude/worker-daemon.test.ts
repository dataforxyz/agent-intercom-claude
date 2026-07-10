import assert from "node:assert/strict";
import test from "node:test";
import { formatWorkerActivity, VirtualClaudeAgent, type WorkerActivity } from "./worker-daemon.ts";
import type { WorkerAgentConfig } from "./worker-config.ts";
import type { Message, SessionInfo } from "../types.ts";

const agent: WorkerAgentConfig = { id: "claude-worker", name: "Claude worker", cwd: "/tmp" };
const from: SessionInfo = {
  id: "sender-1",
  name: "Pi manager",
  cwd: "/tmp",
  model: "pi",
  pid: 1,
  startedAt: 1,
  lastActivity: 1,
};
const message: Message = {
  id: "message-1",
  content: { text: "Please inspect the failure" },
  timestamp: 1,
};

test("attached worker displays inbound work before Claude starts", () => {
  const output = formatWorkerActivity({ type: "started", agent, from, message });
  assert.match(output, /Wake from Pi manager: Please inspect the failure/);
  assert.match(output, /Claude is working/);
});

test("attached worker displays the final result and resumable session", () => {
  const output = formatWorkerActivity({
    type: "completed",
    agent,
    from,
    message,
    result: "The failure is in the retry loop.",
    sessionId: "claude-session-123",
  });
  assert.match(output, /Completed wake from Pi manager/);
  assert.match(output, /session claude-session-123/);
  assert.match(output, /The failure is in the retry loop/);
});

test("attached worker displays wake failures", () => {
  const output = formatWorkerActivity({ type: "error", agent, from, message, error: "Claude exited 1" });
  assert.match(output, /Wake from Pi manager failed: Claude exited 1/);
});

test("worker reports a real turn lifecycle and preserves blocking-ask replies", async () => {
  const activities: WorkerActivity[] = [];
  const sends: Array<{ to: string; message: { text: string; replyTo?: string } }> = [];
  const worker = new VirtualClaudeAgent(
    agent,
    { agents: {} },
    "/tmp/unused-worker-state.json",
    "claude",
    (activity) => activities.push(activity),
    async () => ({ sessionId: null, result: "VISIBLE_WAKE_OK", isError: false, raw: {} }),
  );
  (worker as any).client = {
    updatePresence() {},
    async send(to: string, outgoing: { text: string; replyTo?: string }) {
      sends.push({ to, message: outgoing });
      return { delivered: true };
    },
  };

  await (worker as any).handleMessage(from, { ...message, expectsReply: true });

  assert.deepEqual(activities.map((activity) => activity.type), ["started", "completed"]);
  assert.equal(activities[1]?.type === "completed" && activities[1].result, "VISIBLE_WAKE_OK");
  assert.deepEqual(sends, [{
    to: from.id,
    message: { text: "VISIBLE_WAKE_OK", replyTo: message.id },
  }]);
});

test("worker visibly reports Claude result errors without changing the ask reply", async () => {
  const activities: WorkerActivity[] = [];
  const sends: Array<{ text: string; replyTo?: string }> = [];
  const worker = new VirtualClaudeAgent(
    agent,
    { agents: {} },
    "/tmp/unused-worker-state.json",
    "claude",
    (activity) => activities.push(activity),
    async () => ({ sessionId: null, result: "Not logged in", isError: true, raw: {} }),
  );
  (worker as any).client = {
    updatePresence() {},
    async send(_to: string, outgoing: { text: string; replyTo?: string }) {
      sends.push(outgoing);
      return { delivered: true };
    },
  };

  await (worker as any).handleMessage(from, { ...message, expectsReply: true });

  assert.deepEqual(activities.map((activity) => activity.type), ["started", "error"]);
  assert.equal(activities[1]?.type === "error" && activities[1].error, "Not logged in");
  assert.deepEqual(sends, [{ text: "Not logged in", replyTo: message.id }]);
});
