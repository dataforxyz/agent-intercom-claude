import { once } from "node:events";
import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { runClaudeTurn } from "./cli-runner.ts";
import {
  loadWorkerConfig,
  loadWorkerState,
  saveWorkerState,
  type WorkerAgentConfig,
  type WorkerConfig,
  type WorkerState,
} from "./worker-config.ts";
import { IntercomClient } from "../broker/client.ts";
import { spawnBrokerIfNeeded } from "../broker/spawn.ts";
import { loadConfig } from "../config.ts";
import type { Message, SessionInfo } from "../types.ts";
import { formatAttachments } from "./runtime.ts";

const MAX_WAKES_PER_MINUTE = 20;

function formatMessage(from: SessionInfo, message: Message, agent: WorkerAgentConfig): string {
  const replyInstruction = message.expectsReply
    ? [
      "",
      "",
      "The sender is blocking on your reply.",
      "Your FINAL assistant message will be sent back to them automatically as the reply.",
      "Do not try to use intercom tools to answer; just put your answer in your final message.",
    ].join("\n")
    : "";
  const attachments = formatAttachments(message.content.attachments);
  const custom = agent.instructions ? `\n\nAgent instructions:\n${agent.instructions}` : "";
  return [
    `Intercom message for ${agent.name}.`,
    `From: ${from.name || from.id} (${from.id})`,
    `Message id: ${message.id}`,
    "",
    message.content.text,
    attachments,
    custom,
    replyInstruction,
  ].join("\n");
}

export class VirtualClaudeAgent {
  private client = new IntercomClient();
  private sessionId: string | null;
  private messageQueue: Promise<void> = Promise.resolve();
  private wakeTimestamps: number[] = [];

  constructor(
    private readonly agent: WorkerAgentConfig,
    private readonly state: WorkerState,
    private readonly statePath: string,
    private readonly claudeCommand: string,
  ) {
    this.sessionId = agent.sessionId ?? state.agents[agent.id]?.sessionId ?? null;
  }

  get id(): string {
    return this.agent.id;
  }

  async start(): Promise<void> {
    this.client.on("message", (from: SessionInfo, message: Message) => {
      this.routeMessage(from, message);
    });
    this.client.on("error", (error: Error) => {
      process.stderr.write(`worker ${this.agent.id}: ${error.message}\n`);
    });
    await this.client.connect({
      name: this.agent.name,
      cwd: this.agent.cwd,
      model: this.agent.model ?? "claude",
      pid: process.pid,
      startedAt: Date.now(),
      lastActivity: Date.now(),
      status: "idle",
    }, this.agent.id);
  }

  async stop(): Promise<void> {
    await this.client.disconnect();
  }

  private routeMessage(from: SessionInfo, message: Message): void {
    if (this.isRateLimited()) {
      process.stderr.write(`worker ${this.agent.id}: rate limited, dropping message from ${from.id}\n`);
      if (message.expectsReply) {
        void this.client.send(from.id, {
          text: "This worker is rate limited (too many wakes this minute). Please try again shortly.",
          replyTo: message.id,
        }).catch((error) => {
          process.stderr.write(`worker ${this.agent.id}: rate-limit reply failed: ${error instanceof Error ? error.message : String(error)}\n`);
        });
      }
      return;
    }

    this.messageQueue = this.messageQueue
      .catch(() => undefined)
      .then(() => this.handleMessage(from, message));
  }

  private isRateLimited(): boolean {
    const now = Date.now();
    this.wakeTimestamps = this.wakeTimestamps.filter((timestamp) => now - timestamp < 60000);
    if (this.wakeTimestamps.length >= MAX_WAKES_PER_MINUTE) return true;
    this.wakeTimestamps.push(now);
    return false;
  }

  private async handleMessage(from: SessionInfo, message: Message): Promise<void> {
    try {
      const prompt = formatMessage(from, message, this.agent);
      this.client.updatePresence({ status: "active" });

      const result = await runClaudeTurn({
        prompt,
        cwd: this.agent.cwd,
        sessionId: this.sessionId ?? undefined,
        model: this.agent.model,
        appendSystemPrompt: this.agent.instructions,
        permissionMode: this.agent.permissionMode ?? "bypassPermissions",
        dangerouslySkipPermissions: this.agent.dangerouslySkipPermissions,
        addDirs: this.agent.addDirs,
        mcpConfig: this.agent.mcpConfig,
        claudeCommand: this.claudeCommand,
        extraArgs: this.agent.claudeArgs,
      });

      if (result.sessionId && result.sessionId !== this.sessionId) {
        this.sessionId = result.sessionId;
        this.state.agents[this.agent.id] = { sessionId: result.sessionId, updatedAt: Date.now() };
        saveWorkerState(this.statePath, this.state);
      }

      this.client.updatePresence({ status: "idle" });

      if (message.expectsReply) {
        await this.client.send(from.id, {
          text: result.result || "(the worker finished without a final message)",
          replyTo: message.id,
        });
        process.stderr.write(`worker ${this.agent.id}: replied to ${from.name || from.id} (session ${this.sessionId ?? "none"})\n`);
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      this.client.updatePresence({ status: `error: ${text}` });
      if (message.expectsReply) {
        await this.client.send(from.id, {
          text: `Worker error: ${text}`,
          replyTo: message.id,
        }).catch((sendError) => {
          process.stderr.write(`worker ${this.agent.id}: error reply failed: ${sendError instanceof Error ? sendError.message : String(sendError)}\n`);
        });
      }
    }
  }
}

export class ClaudeWorkerDaemon {
  private agents: VirtualClaudeAgent[] = [];

  constructor(private readonly config: WorkerConfig) {}

  async start(): Promise<void> {
    const intercomConfig = loadConfig();
    await spawnBrokerIfNeeded(intercomConfig.brokerCommand, intercomConfig.brokerArgs);
    const state = loadWorkerState(this.config.statePath);
    const claudeCommand = this.config.claudeCommand ?? "claude";
    this.agents = this.config.agents.map((agent) => new VirtualClaudeAgent(agent, state, this.config.statePath, claudeCommand));
    for (const agent of this.agents) await agent.start();
    process.stderr.write(`claude-intercom worker running ${this.agents.length} agent(s)\n`);
  }

  async stop(): Promise<void> {
    for (const agent of this.agents) await agent.stop().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const configPath = process.argv.includes("--config")
    ? process.argv[process.argv.indexOf("--config") + 1]
    : undefined;
  const config = loadWorkerConfig(configPath);
  if (!config.agents.length) throw new Error("Worker config must include at least one agent");
  const daemon = new ClaudeWorkerDaemon(config);
  const stop = () => {
    void daemon.stop().finally(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await daemon.start();
  await once(process, "SIGTERM");
}

// See cci.ts: realpath the invoked path so the `claude-intercom-worker` npm-bin
// symlink resolves to the real bundle file (worker-daemon.mjs) and triggers main.
function invokedFileBasename(): string {
  try {
    return process.argv[1] ? basename(realpathSync(process.argv[1])) : "";
  } catch {
    return process.argv[1] ? basename(process.argv[1]) : "";
  }
}

if (invokedFileBasename() === "worker-daemon.ts" || invokedFileBasename() === "worker-daemon.mjs") {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}
