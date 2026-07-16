import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { formatWorkerActivity, VirtualClaudeAgent, type WorkerActivity } from "./worker-daemon.ts";
import type { IntercomClient } from "../broker/client.ts";
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
class FakeIntercomClient extends EventEmitter {
  connected = false;
  connectCount = 0;
  sessionId: string | null = null;

  isConnected(): boolean { return this.connected; }
  async connect(_registration: unknown, sessionId?: string): Promise<void> {
    this.connected = true;
    this.connectCount += 1;
    this.sessionId = sessionId ?? "fake-session";
  }
  async disconnect(): Promise<void> {
    this.connected = false;
    this.sessionId = null;
  }
  updatePresence(): void {}
  drop(): void {
    this.connected = false;
    this.sessionId = null;
    this.emit("disconnected", new Error("broker restarted"));
  }
}

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

test("persistent Claude worker reconnects its stable Intercom identity after broker restart", async () => {
  const client = new FakeIntercomClient();
  const worker = new VirtualClaudeAgent(
    agent,
    { agents: {} },
    "/tmp/unused-worker-state.json",
    "claude",
    () => {},
    async () => ({ sessionId: null, result: "unused", isError: false, raw: {} }),
    {
      client: client as unknown as IntercomClient,
      prepareConnection: async () => {},
      reconnectDelays: [1],
    },
  );

  await worker.start();
  client.drop();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(client.connectCount, 2);
  assert.equal(client.sessionId, agent.id);
  await worker.stop();
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
