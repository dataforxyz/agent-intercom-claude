import test from "node:test";
import assert from "node:assert/strict";
import { IntercomClient } from "./client.ts";
import { INTERCOM_PROTOCOL_NAME, INTERCOM_PROTOCOL_VERSION } from "./paths.ts";

test("cancelAsk resolves false after synchronous socket write failures", async () => {
  const client = new IntercomClient();
  (client as any)._sessionId = "session-1";
  (client as any).socket = {
    destroyed: false,
    writableEnded: false,
    writable: true,
    write() {
      throw new Error("write failed");
    },
  };

  assert.equal(await client.cancelAsk("ask-1"), false);
});

test("requested Boss registration cannot downgrade to an ordinary registered response", () => {
  const client = new IntercomClient();
  (client as any).requestedBossRegistration = {};
  assert.throws(() => (client as any).handleBrokerMessage({
    type: "registered",
    sessionId: "session-1",
    protocol: INTERCOM_PROTOCOL_NAME,
    version: INTERCOM_PROTOCOL_VERSION,
    capabilities: { baseProtocolVersion: 3, features: [] },
  }), /downgraded to an ordinary session/);
});

test("ordinary clients reject unsolicited Boss metadata and control traffic", () => {
  const client = new IntercomClient();
  assert.throws(() => (client as any).handleBrokerMessage({
    type: "registered",
    sessionId: "session-1",
    protocol: INTERCOM_PROTOCOL_NAME,
    version: INTERCOM_PROTOCOL_VERSION,
    boss: {},
  }), /Invalid registered message/);
  for (const folded of ["Boss", "BOSS", "bossRunId", "bindingEpoch", "Capabilities"]) {
    assert.throws(() => (client as any).handleBrokerMessage({
      type: "registered",
      sessionId: "session-1",
      protocol: INTERCOM_PROTOCOL_NAME,
      version: INTERCOM_PROTOCOL_VERSION,
      [folded]: {},
    }), /Invalid registered message/, folded);
  }
  (client as any)._sessionId = "session-1";
  assert.throws(() => (client as any).handleBrokerMessage({
    type: "message",
    deliveryId: "delivery-1",
    from: { id: "sender", cwd: "/tmp", model: "test", pid: 1, startedAt: 1, lastActivity: 1 },
    message: {
      id: "message-1",
      timestamp: 1,
      control: {
        type: "boss.worker.health",
        version: 1,
        messageId: "message-1",
        bossRunId: "boss-run",
        participantId: "participant",
        bindingEpoch: 1,
        idempotencyKey: "health-1",
        payload: {},
      },
      content: { text: "" },
    },
  }), /unavailable Boss control traffic/);
});

function clientWithPending(accepted = false, deliveryId?: string): { client: IntercomClient; results: unknown[] } {
  const client = new IntercomClient();
  const results: unknown[] = [];
  (client as any)._sessionId = "session-1";
  (client as any).pendingSends.set("message-1", {
    accepted,
    ...(deliveryId ? { deliveryId } : {}),
    resolve: (value: unknown) => results.push(value),
    reject: (error: unknown) => { throw error; },
  });
  return { client, results };
}

test("delivery results require acceptance ordering and exact delivery-ID correlation", () => {
  const beforeAccepted = clientWithPending();
  assert.throws(() => (beforeAccepted.client as any).handleBrokerMessage({
    type: "delivered",
    messageId: "message-1",
    deliveryId: "delivery-1",
  }), /before delivery acceptance/);

  const mismatch = clientWithPending(true, "delivery-1");
  assert.throws(() => (mismatch.client as any).handleBrokerMessage({
    type: "delivered",
    messageId: "message-1",
    deliveryId: "delivery-2",
  }), /mismatched delivery ID/);

  const duplicate = clientWithPending(true, "delivery-1");
  assert.throws(() => (duplicate.client as any).handleBrokerMessage({
    type: "delivery_accepted",
    messageId: "message-1",
    deliveryId: "delivery-1",
  }), /Duplicate delivery_accepted/);

  const valid = clientWithPending();
  (valid.client as any).handleBrokerMessage({ type: "delivery_accepted", messageId: "message-1", deliveryId: "delivery-1" });
  (valid.client as any).handleBrokerMessage({ type: "delivered", messageId: "message-1", deliveryId: "delivery-1" });
  assert.deepEqual(valid.results, [{ id: "message-1", accepted: true, delivered: true, deliveryId: "delivery-1" }]);
  assert.throws(() => (valid.client as any).handleBrokerMessage({
    type: "delivered",
    messageId: "message-1",
    deliveryId: "delivery-1",
  }), /without a pending send/);

  const unsolicited = new IntercomClient();
  (unsolicited as any)._sessionId = "session-1";
  assert.throws(() => (unsolicited as any).handleBrokerMessage({
    type: "delivery_accepted",
    messageId: "message-1",
    deliveryId: "delivery-1",
  }), /without a pending send/);
});

test("delivery failures use the exact code schema and cannot contradict acceptance", () => {
  const unknown = clientWithPending();
  assert.throws(() => (unknown.client as any).handleBrokerMessage({
    type: "delivery_failed",
    messageId: "message-1",
    accepted: false,
    code: "UNKNOWN_FAILURE",
    reason: "hostile",
  }), /Invalid delivery_failed/);

  const contradictory = clientWithPending(true, "delivery-1");
  assert.throws(() => (contradictory.client as any).handleBrokerMessage({
    type: "delivery_failed",
    messageId: "message-1",
    accepted: false,
    code: "DELIVERY_TIMEOUT",
    reason: "hostile",
  }), /contradicted/);

  const unavailable = clientWithPending();
  (unavailable.client as any).handleBrokerMessage({
    type: "delivery_failed",
    messageId: "message-1",
    accepted: false,
    code: "CONTROL_DISPATCH_UNAVAILABLE",
    reason: "typed dispatch is unavailable",
  });
  assert.deepEqual(unavailable.results, [{
    id: "message-1",
    accepted: false,
    delivered: false,
    code: "CONTROL_DISPATCH_UNAVAILABLE",
    reason: "typed dispatch is unavailable",
  }]);
});

function clientWithQueuedOutbox(messageIds: string[] = ["message-1"]): {
  client: IntercomClient;
  entries: Array<{ to: string; message: { id: string; timestamp: number; content: { text: string } }; queuedAt: number }>;
} {
  const client = new IntercomClient();
  const entries = messageIds.map((id) => ({
    to: "recipient",
    message: { id, timestamp: 1, content: { text: id } },
    queuedAt: 1,
  }));
  (client as any)._sessionId = "session-1";
  (client as any).outbox = {
    list: () => entries.map((entry) => ({ ...entry, message: { ...entry.message, content: { ...entry.message.content } } })),
    enqueue: (to: string, message: { id: string; timestamp: number; content: { text: string } }) => {
      entries.push({ to, message, queuedAt: 1 });
      return "added";
    },
    remove: (messageId: string) => {
      const index = entries.findIndex((entry) => entry.message.id === messageId);
      if (index !== -1) entries.splice(index, 1);
    },
  };
  return { client, entries };
}

function installWritableSocket(client: IntercomClient, writes: Buffer[] = []): Buffer[] {
  (client as any).socket = {
    destroyed: false,
    writableEnded: false,
    writable: true,
    write(data: Buffer) {
      writes.push(data);
      return true;
    },
  };
  return writes;
}

test("a durable send accepts late acceptance and delivery after its caller times out", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const { client, entries } = clientWithQueuedOutbox([]);
  installWritableSocket(client);
  const acceptedEvents: unknown[][] = [];
  const deliveredEvents: unknown[][] = [];
  client.on("delivery_accepted", (...args: unknown[]) => acceptedEvents.push(args));
  client.on("outbox_delivered", (...args: unknown[]) => deliveredEvents.push(args));

  const result = client.send("recipient", { text: "durable", messageId: "message-1" });
  context.mock.timers.tick(10_000);
  await assert.rejects(result, /Send timeout/);
  assert.equal((client as any).pendingSends.has("message-1"), false);
  assert.equal(entries.length, 1);

  (client as any).handleBrokerMessage({
    type: "delivery_accepted",
    messageId: "message-1",
    deliveryId: "delivery-1",
  });
  (client as any).handleBrokerMessage({
    type: "delivered",
    messageId: "message-1",
    deliveryId: "delivery-1",
  });

  assert.deepEqual(acceptedEvents, [["message-1", "delivery-1"]]);
  assert.deepEqual(deliveredEvents, [["message-1", "delivery-1"]]);
  assert.equal(entries.length, 0);
});

test("an accepted durable send retains delivery correlation when its caller times out", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const { client, entries } = clientWithQueuedOutbox([]);
  installWritableSocket(client);
  const failedEvents: unknown[][] = [];
  client.on("outbox_failed", (...args: unknown[]) => failedEvents.push(args));

  const result = client.send("recipient", { text: "durable", messageId: "message-1" });
  (client as any).handleBrokerMessage({
    type: "delivery_accepted",
    messageId: "message-1",
    deliveryId: "delivery-1",
  });
  context.mock.timers.tick(10_000);
  await assert.rejects(result, /Send timeout/);

  (client as any).handleBrokerMessage({
    type: "delivery_failed",
    messageId: "message-1",
    accepted: true,
    code: "DELIVERY_TIMEOUT",
    reason: "recipient acknowledgement timed out",
  });

  assert.deepEqual(failedEvents, [["message-1", "DELIVERY_TIMEOUT", "recipient acknowledgement timed out"]]);
  assert.equal(entries.length, 0);
});

test("outbox-only delivery failures preserve acceptance chronology", () => {
  const beforeAcceptance = clientWithQueuedOutbox();
  const beforeEvents: unknown[][] = [];
  beforeAcceptance.client.on("outbox_failed", (...args: unknown[]) => beforeEvents.push(args));
  (beforeAcceptance.client as any).handleBrokerMessage({
    type: "delivery_failed",
    messageId: "message-1",
    accepted: false,
    code: "SESSION_NOT_FOUND",
    reason: "recipient disappeared",
  });
  assert.deepEqual(beforeEvents, [["message-1", "SESSION_NOT_FOUND", "recipient disappeared"]]);
  assert.equal(beforeAcceptance.entries.length, 0);

  const contradictoryBefore = clientWithQueuedOutbox();
  assert.throws(() => (contradictoryBefore.client as any).handleBrokerMessage({
    type: "delivery_failed",
    messageId: "message-1",
    accepted: true,
    code: "DELIVERY_TIMEOUT",
    reason: "hostile",
  }), /contradicted/);
  assert.equal(contradictoryBefore.entries.length, 1);

  const contradictoryAfter = clientWithQueuedOutbox();
  (contradictoryAfter.client as any).handleBrokerMessage({
    type: "delivery_accepted",
    messageId: "message-1",
    deliveryId: "delivery-1",
  });
  assert.throws(() => (contradictoryAfter.client as any).handleBrokerMessage({
    type: "delivery_failed",
    messageId: "message-1",
    accepted: false,
    code: "SESSION_NOT_FOUND",
    reason: "hostile",
  }), /contradicted/);
  assert.equal(contradictoryAfter.entries.length, 1);
});

test("outbox-only delivery correlation rejects duplicate, mismatched, and substituted frames", () => {
  const { client, entries } = clientWithQueuedOutbox();

  for (const frame of [
    { type: "delivery_accepted", messageId: "message-2", deliveryId: "delivery-1" },
    { type: "delivered", messageId: "message-2", deliveryId: "delivery-1" },
    {
      type: "delivery_failed",
      messageId: "message-2",
      accepted: false,
      code: "SESSION_NOT_FOUND",
      reason: "hostile",
    },
  ]) {
    assert.throws(() => (client as any).handleBrokerMessage(frame), /without a pending send or queued outbox message/);
  }

  const acceptance = { type: "delivery_accepted", messageId: "message-1", deliveryId: "delivery-1" };
  (client as any).handleBrokerMessage(acceptance);
  assert.throws(() => (client as any).handleBrokerMessage(acceptance), /Duplicate delivery_accepted/);
  assert.throws(() => (client as any).handleBrokerMessage({
    type: "delivered",
    messageId: "message-1",
    deliveryId: "delivery-2",
  }), /mismatched delivery ID/);
  assert.equal(entries.length, 1);

  (client as any).handleBrokerMessage({
    type: "delivered",
    messageId: "message-1",
    deliveryId: "delivery-1",
  });
  assert.equal(entries.length, 0);
  assert.throws(() => (client as any).handleBrokerMessage({
    type: "delivered",
    messageId: "message-1",
    deliveryId: "delivery-1",
  }), /without a pending send or queued outbox message/);
});

test("outbox replay establishes a fresh pending delivery and emits its terminal event", () => {
  const { client, entries } = clientWithQueuedOutbox();
  const writes = installWritableSocket(client);
  const deliveredEvents: unknown[][] = [];
  client.on("outbox_delivered", (...args: unknown[]) => deliveredEvents.push(args));

  (client as any).lateDeliveryAcceptances.set("message-1", "stale-delivery");
  (client as any).replayOutbox();
  assert.equal(writes.length, 1);
  assert.deepEqual(JSON.parse(writes[0].subarray(4).toString("utf8")), {
    type: "send",
    to: "recipient",
    message: { id: "message-1", timestamp: 1, content: { text: "message-1" } },
  });
  assert.equal((client as any).pendingSends.has("message-1"), true);
  assert.equal((client as any).lateDeliveryAcceptances.has("message-1"), false);

  (client as any).handleBrokerMessage({
    type: "delivery_accepted",
    messageId: "message-1",
    deliveryId: "delivery-replay",
  });
  (client as any).handleBrokerMessage({
    type: "delivered",
    messageId: "message-1",
    deliveryId: "delivery-replay",
  });
  assert.deepEqual(deliveredEvents, [["message-1", "delivery-replay"]]);
  assert.equal(entries.length, 0);
});
