// One-shot broker ask helper for E2E scripts.
// Env: PROBE_TARGET (worker id), PROBE_ASK (message text).
import { IntercomClient } from "../../broker/client.ts";
import { spawnBrokerIfNeeded } from "../../broker/spawn.ts";
import { randomUUID } from "node:crypto";
import type { Message, SessionInfo } from "../../types.ts";

const TARGET = process.env.PROBE_TARGET ?? "e2e-worker";
const ASK = process.env.PROBE_ASK ?? "Reply with OK.";

async function main() {
  await spawnBrokerIfNeeded("npx", ["--no-install", "tsx"]);
  const client = new IntercomClient();
  const replies = new Map<string, (m: Message) => void>();
  client.on("message", (_from: SessionInfo, message: Message) => {
    if (message.replyTo && replies.has(message.replyTo)) {
      replies.get(message.replyTo)!(message);
      replies.delete(message.replyTo);
    }
  });
  await client.connect({
    name: "ask-once-" + process.pid, cwd: process.cwd(), model: "probe",
    pid: process.pid, startedAt: Date.now(), lastActivity: Date.now(), status: "idle",
  }, "ask-once-" + process.pid);

  const id = randomUUID();
  const reply = await new Promise<string>((resolve, reject) => {
    const t = setTimeout(() => { replies.delete(id); reject(new Error("timeout")); }, 240000);
    replies.set(id, (m) => { clearTimeout(t); resolve(m.content.text); });
    client.send(TARGET, { messageId: id, text: ASK, expectsReply: true }).then((res) => {
      if (!res.delivered) { clearTimeout(t); replies.delete(id); reject(new Error("not delivered: " + res.reason)); }
    }, (e) => { clearTimeout(t); replies.delete(id); reject(e); });
  });

  console.log("REPLY <-", JSON.stringify(reply.trim()));
  await client.disconnect();
  process.exit(0);
}
main().catch((e) => { console.error("ASK ERROR:", e instanceof Error ? e.message : e); process.exit(2); });
