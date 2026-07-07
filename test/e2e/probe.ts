// Direct broker-client probe used by the E2E harness.
// Sends two blocking asks to a worker: the second can only be answered from
// memory if the worker RESUMED the same Claude conversation.
// Config via env: PROBE_TARGET (worker id), PROBE_CODEWORD, PROBE_SECRET_RE.
import { IntercomClient } from "../../broker/client.ts";
import { spawnBrokerIfNeeded } from "../../broker/spawn.ts";
import { randomUUID } from "node:crypto";
import type { Message, SessionInfo } from "../../types.ts";

const TARGET = process.env.PROBE_TARGET ?? "e2e-worker";
const CODEWORD = process.env.PROBE_CODEWORD ?? "PURPLE-OTTER";

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
    name: "e2e-probe-" + process.pid, cwd: process.cwd(), model: "probe",
    pid: process.pid, startedAt: Date.now(), lastActivity: Date.now(), status: "idle",
  }, "e2e-probe-" + process.pid);

  const ask = (text: string) => new Promise<string>((resolve, reject) => {
    const id = randomUUID();
    const t = setTimeout(() => { replies.delete(id); reject(new Error("timeout waiting for reply")); }, 170000);
    replies.set(id, (m) => { clearTimeout(t); resolve(m.content.text); });
    client.send(TARGET, { messageId: id, text, expectsReply: true }).then((res) => {
      if (!res.delivered) { clearTimeout(t); replies.delete(id); reject(new Error("not delivered: " + res.reason)); }
    }, (e) => { clearTimeout(t); replies.delete(id); reject(e); });
  });

  const q1 = `Remember this codeword for later: ${CODEWORD}. Reply with just: OK`;
  console.log("ASK 1 ->", q1);
  const r1 = await ask(q1);
  console.log("REPLY 1 <-", JSON.stringify(r1.trim()));

  const q2 = "What codeword did I ask you to remember earlier in THIS same conversation? Do not read any files; answer from memory only.";
  console.log("ASK 2 ->", q2);
  const r2 = await ask(q2);
  console.log("REPLY 2 <-", JSON.stringify(r2.trim()));

  await client.disconnect();
  const pass = new RegExp(CODEWORD, "i").test(r2);
  console.log(pass
    ? `CONTINUITY: PASS — worker resumed the same session and recalled ${CODEWORD}`
    : `CONTINUITY: FAIL — expected ${CODEWORD} in reply 2`);
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error("PROBE ERROR:", e instanceof Error ? e.message : e); process.exit(2); });
