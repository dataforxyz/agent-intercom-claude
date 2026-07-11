// Headless verification of the cci --tui delivery pipeline (everything except
// the live claude injection, which needs a real terminal):
//   MCP server (with CLAUDE_INTERCOM_INBOX) registers on the broker
//   -> a peer sends it a message
//   -> the intercom MCP server appends it to the inbox file
//   -> dist/inbox-monitor.mjs tails the inbox and emits the formatted line
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { IntercomClient } from "../../broker/client.ts";
import { spawnBrokerIfNeeded } from "../../broker/spawn.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TARGET = "tui-verify";

async function main() {
  await spawnBrokerIfNeeded("npx", ["--no-install", "tsx"]);
  const dir = mkdtempSync(join(tmpdir(), "cci-tui-"));
  const inbox = join(dir, "inbox.jsonl");

  // 1. MCP server eager-registers `tui-verify` and mirrors inbound to the inbox.
  const server = spawn("node", [join(ROOT, "dist", "claude-server.mjs")], {
    stdio: ["pipe", "ignore", "inherit"],
    env: { ...process.env, CLAUDE_INTERCOM_NAME: TARGET, CLAUDE_INTERCOM_SESSION_ID: TARGET, CLAUDE_INTERCOM_INBOX: inbox },
  });

  // 2. Peer connects and waits for the server to appear on the broker.
  const peer = new IntercomClient();
  await peer.connect({ name: "tui-peer", cwd: dir, model: "probe", pid: process.pid, startedAt: Date.now(), lastActivity: Date.now(), status: "idle" }, "tui-peer");
  let registered = false;
  for (let i = 0; i < 40; i++) {
    const sessions = await peer.listSessions();
    if (sessions.some((s) => s.id === TARGET)) { registered = true; break; }
    await delay(250);
  }
  if (!registered) throw new Error("MCP server never registered on the broker");
  console.log("OK: server registered on broker");

  // 3. Start the inbox monitor and capture its stdout.
  const monitor = spawn("node", [join(ROOT, "dist", "inbox-monitor.mjs")], {
    stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env, CLAUDE_INTERCOM_INBOX: inbox },
  });
  let monitorOut = "";
  monitor.stdout.on("data", (c) => { monitorOut += c.toString(); });
  await delay(500); // let the monitor establish its baseline (skip backlog)

  // 4. Peer sends a blocking-style ask to the target.
  await peer.send(TARGET, { messageId: "verify-1", text: "please confirm the pipeline works", expectsReply: true });

  // 5. Assert the inbox file got the message and the monitor emitted the line.
  let inboxOk = false;
  for (let i = 0; i < 40; i++) {
    if (existsSync(inbox) && readFileSync(inbox, "utf-8").includes("please confirm the pipeline works")) { inboxOk = true; break; }
    await delay(250);
  }
  let monitorOk = false;
  for (let i = 0; i < 20; i++) {
    if (/Intercom message from tui-peer .*\[asking — awaiting your reply\]: please confirm the pipeline works/.test(monitorOut)) { monitorOk = true; break; }
    await delay(250);
  }

  console.log("inbox file written:", inboxOk);
  console.log("monitor emitted line:", monitorOk);
  console.log("monitor stdout:", JSON.stringify(monitorOut.trim()));

  server.kill(); monitor.kill(); await peer.disconnect();
  const pass = inboxOk && monitorOk;
  console.log(pass ? "TUI PIPELINE: PASS" : "TUI PIPELINE: FAIL");
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error("ERROR:", e instanceof Error ? e.message : e); process.exit(2); });
