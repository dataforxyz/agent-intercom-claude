import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createMessageReader, writeMessage } from "./framing.ts";

const repoDir = resolve(import.meta.dirname, "..");
const brokerEntry = process.env.CLAUDE_INTERCOM_TEST_BROKER_ENTRY || join(repoDir, "broker", "broker.ts");

class RawPeer {
  readonly messages: any[] = [];
  private waiters: Array<{
    predicate: (message: any) => boolean;
    resolve: (message: any) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }> = [];

  constructor(readonly socket: net.Socket) {
    socket.on("data", createMessageReader((message) => {
      this.messages.push(message);
      for (const waiter of [...this.waiters]) {
        if (waiter.predicate(message)) {
          clearTimeout(waiter.timeout);
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          waiter.resolve(message);
        }
      }
    }, (error) => {
      for (const waiter of this.waiters.splice(0)) {
        clearTimeout(waiter.timeout);
        waiter.reject(error);
      }
    }));
  }

  send(message: unknown): void {
    writeMessage(this.socket, message);
  }

  waitFor(predicate: (message: any) => boolean, timeoutMs = 3000): Promise<any> {
    const existing = this.messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        reject,
        timeout: setTimeout(() => {
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          reject(new Error(`Timed out waiting for broker message; received ${JSON.stringify(this.messages)}`));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  close(): void {
    this.socket.destroy();
  }
}

async function connect(socketPath: string): Promise<RawPeer> {
  const socket = net.connect(socketPath);
  await once(socket, "connect");
  return new RawPeer(socket);
}

function registration(options: {
  id: string;
  name: string;
  pid: number;
  startedAt: number;
  runtimeInstanceId?: string;
}) {
  return {
    type: "register",
    protocol: "pi-intercom",
    version: 3,
    sessionId: options.id,
    session: {
      name: options.name,
      cwd: repoDir,
      model: "test-model",
      pid: options.pid,
      startedAt: options.startedAt,
      lastActivity: Date.now(),
      ...(options.runtimeInstanceId ? { runtimeInstanceId: options.runtimeInstanceId } : {}),
    },
  };
}

async function register(peer: RawPeer, options: Parameters<typeof registration>[0]): Promise<any> {
  peer.send(registration(options));
  return await peer.waitFor((message) => message.type === "registered" || message.type === "error");
}

async function waitForBrokerReady(broker: ChildProcessWithoutNullStreams): Promise<void> {
  await new Promise<void>((resolveReady, reject) => {
    const timeout = setTimeout(() => reject(new Error("broker startup timeout")), 10_000);
    broker.stdout.on("data", function onData(chunk: Buffer) {
      if (chunk.toString().includes("Intercom broker started")) {
        clearTimeout(timeout);
        broker.stdout.off("data", onData);
        resolveReady();
      }
    });
    broker.once("exit", (code) => reject(new Error(`broker exited early: ${code}`)));
  });
}

async function stopBroker(broker: ChildProcessWithoutNullStreams): Promise<void> {
  if (broker.exitCode !== null || broker.signalCode !== null) return;
  const exited = once(broker, "exit");
  broker.kill("SIGTERM");
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2000))]);
  if (broker.exitCode === null && broker.signalCode === null) broker.kill("SIGKILL");
}

test("stable local session IDs reject competing runtimes without disturbing the incumbent", { concurrency: false }, async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "agent-intercom-session-collision-"));
  const socketPath = join(agentDir, "intercom", "broker.sock");
  const brokerArgs = brokerEntry.endsWith(".ts") ? ["--import", "tsx", brokerEntry] : [brokerEntry];
  const broker = spawn(process.execPath, brokerArgs, {
    cwd: repoDir,
    env: { ...process.env, HOME: agentDir, USERPROFILE: agentDir, PI_CODING_AGENT_DIR: agentDir },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const peers: RawPeer[] = [];

  try {
    await waitForBrokerReady(broker);

    const sender = await connect(socketPath);
    peers.push(sender);
    assert.equal((await register(sender, {
      id: "sender-id",
      name: "sender",
      pid: 10,
      startedAt: 100,
      runtimeInstanceId: "sender-runtime",
    })).type, "registered");

    for (const folded of ["Boss", "BOSS", "bossRunId"]) {
      const hostile = await connect(socketPath);
      peers.push(hostile);
      hostile.send({
        ...registration({ id: `folded-${folded}`, name: "folded", pid: 91, startedAt: 901 }),
        [folded]: {},
      });
      const response = await hostile.waitFor((message) => message.type === "error");
      assert.equal(response.code, "INVALID_REQUEST", folded);
    }

    const foldedSession = await connect(socketPath);
    peers.push(foldedSession);
    const foldedRegistration = registration({ id: "folded-session", name: "folded", pid: 92, startedAt: 902 });
    foldedSession.send({ ...foldedRegistration, session: { ...foldedRegistration.session, Boss: {} } });
    assert.equal((await foldedSession.waitFor((message) => message.type === "error")).code, "INVALID_REQUEST");

    const owner = await connect(socketPath);
    peers.push(owner);
    assert.equal((await register(owner, {
      id: "contested-id",
      name: "owner",
      pid: 11,
      startedAt: 101,
      runtimeInstanceId: "owner-runtime",
    })).type, "registered");

    sender.send({
      type: "send",
      to: "contested-id",
      message: {
        id: "typed-unavailable",
        timestamp: Date.now(),
        control: {
          type: "boss.worker.health",
          version: 1,
          messageId: "typed-unavailable",
          bossRunId: "boss-run-a",
          participantId: "participant-a",
          bindingEpoch: 1,
          idempotencyKey: "health-a",
          payload: {},
        },
        content: { text: "" },
      },
    });
    const unavailable = await sender.waitFor((message) => message.type === "delivery_failed" && message.messageId === "typed-unavailable");
    assert.deepEqual(unavailable, {
      type: "delivery_failed",
      messageId: "typed-unavailable",
      accepted: false,
      code: "CONTROL_DISPATCH_UNAVAILABLE",
      reason: "Typed Boss control dispatch is unavailable without authoritative correlation and durable dispatch",
    });
    assert.equal(sender.messages.some((message) => message.type === "delivery_accepted" && message.messageId === "typed-unavailable"), false);

    sender.send({
      type: "send",
      to: "contested-id",
      message: { id: "pending-message", timestamp: Date.now(), content: { text: "preserve me" } },
    });
    const incoming = await owner.waitFor((message) => message.type === "message" && message.message?.id === "pending-message");
    await sender.waitFor((message) => message.type === "delivery_accepted" && message.messageId === "pending-message");

    const contender = await connect(socketPath);
    peers.push(contender);
    const rejected = await register(contender, {
      id: "contested-id",
      name: "contender",
      pid: 22,
      startedAt: 202,
      runtimeInstanceId: "contender-runtime",
    });
    assert.equal(rejected.type, "error");
    assert.equal(rejected.code, "SESSION_ID_IN_USE");
    assert.match(rejected.error, /already active in another local runtime/);

    owner.send({ type: "message_received", deliveryId: incoming.deliveryId });
    assert.equal((await sender.waitFor((message) => message.type === "delivered" && message.messageId === "pending-message")).deliveryId, incoming.deliveryId);

    owner.send({ type: "list", requestId: "owner-list" });
    const sessions = await owner.waitFor((message) => message.type === "sessions" && message.requestId === "owner-list");
    const incumbent = sessions.sessions.find((session: any) => session.id === "contested-id");
    assert.equal(incumbent.name, "owner");
    assert.equal(incumbent.pid, 11);
    assert.equal("runtimeInstanceId" in incumbent, false);

    const legacyOwner = await connect(socketPath);
    peers.push(legacyOwner);
    assert.equal((await register(legacyOwner, {
      id: "legacy-id",
      name: "legacy-owner",
      pid: 33,
      startedAt: 303,
    })).type, "registered");

    const legacyContender = await connect(socketPath);
    peers.push(legacyContender);
    assert.equal((await register(legacyContender, {
      id: "legacy-id",
      name: "legacy-contender",
      pid: 44,
      startedAt: 404,
    })).code, "SESSION_ID_IN_USE");

    const tokenAgainstLegacy = await connect(socketPath);
    peers.push(tokenAgainstLegacy);
    assert.equal((await register(tokenAgainstLegacy, {
      id: "legacy-id",
      name: "token-contender",
      pid: 33,
      startedAt: 303,
      runtimeInstanceId: "new-token",
    })).code, "SESSION_ID_IN_USE");
  } finally {
    for (const peer of peers) peer.close();
    await stopBroker(broker);
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("matching runtime identity may replace its own stale socket", { concurrency: false }, async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "agent-intercom-session-reconnect-"));
  const socketPath = join(agentDir, "intercom", "broker.sock");
  const broker = spawn(process.execPath, ["--import", "tsx", join(repoDir, "broker", "broker.ts")], {
    cwd: repoDir,
    env: { ...process.env, HOME: agentDir, USERPROFILE: agentDir, PI_CODING_AGENT_DIR: agentDir },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const peers: RawPeer[] = [];

  try {
    await waitForBrokerReady(broker);
    const first = await connect(socketPath);
    peers.push(first);
    assert.equal((await register(first, {
      id: "reconnect-id",
      name: "old-name",
      pid: 55,
      startedAt: 505,
      runtimeInstanceId: "same-runtime",
    })).type, "registered");

    const replacement = await connect(socketPath);
    peers.push(replacement);
    assert.equal((await register(replacement, {
      id: "reconnect-id",
      name: "new-name",
      pid: 66,
      startedAt: 606,
      runtimeInstanceId: "same-runtime",
    })).type, "registered");

    first.send({ type: "presence", name: "stale-name" });
    first.send({ type: "unregister" });
    await new Promise((resolve) => setTimeout(resolve, 50));

    replacement.send({ type: "list", requestId: "replacement-list" });
    const sessions = await replacement.waitFor((message) => message.type === "sessions" && message.requestId === "replacement-list");
    const current = sessions.sessions.find((session: any) => session.id === "reconnect-id");
    assert.equal(current.name, "new-name");
    assert.equal(current.pid, 66);

    const legacyFirst = await connect(socketPath);
    peers.push(legacyFirst);
    assert.equal((await register(legacyFirst, {
      id: "legacy-reconnect-id",
      name: "legacy-old",
      pid: 77,
      startedAt: 707,
    })).type, "registered");
    const legacyReplacement = await connect(socketPath);
    peers.push(legacyReplacement);
    assert.equal((await register(legacyReplacement, {
      id: "legacy-reconnect-id",
      name: "legacy-new",
      pid: 77,
      startedAt: 707,
    })).type, "registered");
  } finally {
    for (const peer of peers) peer.close();
    await stopBroker(broker);
    rmSync(agentDir, { recursive: true, force: true });
  }
});
