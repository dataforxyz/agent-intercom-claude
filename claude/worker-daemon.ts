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
import { formatAttachments, formatSessionDisplay } from "./runtime.ts";
import { copyTextToClipboard, formatContactInstruction } from "./contact.ts";

const MAX_WAKES_PER_MINUTE = 20;

export type WorkerActivity =
  | { type: "started"; agent: WorkerAgentConfig; from: SessionInfo; message: Message }
  | { type: "completed"; agent: WorkerAgentConfig; from: SessionInfo; message: Message; result: string; sessionId: string | null }
  | { type: "error"; agent: WorkerAgentConfig; from: SessionInfo; message: Message; error: string };

export type WorkerActivityReporter = (activity: WorkerActivity) => void;

export interface VirtualClaudeAgentOptions {
  client?: IntercomClient;
  prepareConnection?: () => Promise<void>;
  reconnectDelays?: number[];
}

export function formatWorkerActivity(activity: WorkerActivity): string {
  const sender = formatSessionDisplay(activity.from);
  if (activity.type === "started") {
    return `\n[intercom] Wake from ${sender}: ${activity.message.content.text}\n[intercom] Claude is working…\n`;
  }
  if (activity.type === "completed") {
    const result = activity.result || "(Claude finished without a final message)";
    return `[intercom] Completed wake from ${sender} (session ${activity.sessionId ?? "none"})\n${result}\n`;
  }
  return `[intercom] Wake from ${sender} failed: ${activity.error}\n`;
}

function reportToTerminal(activity: WorkerActivity): void {
  process.stderr.write(formatWorkerActivity(activity));
}

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
    `From: ${formatSessionDisplay(from)} (${from.id})`,
    `Message id: ${message.id}`,
    "",
    message.content.text,
    attachments,
    custom,
    replyInstruction,
  ].join("\n");
}

export class VirtualClaudeAgent {
  private client: IntercomClient;
  private sessionId: string | null;
  private messageQueue: Promise<void> = Promise.resolve();
  private wakeTimestamps: number[] = [];
  private connectPromise: Promise<void> | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private reconnectEnabled = true;
  private readonly intercomStartedAt = Date.now();
  private readonly prepareConnection: () => Promise<void>;
  private readonly reconnectDelays: number[];

  constructor(
    private readonly agent: WorkerAgentConfig,
    private readonly state: WorkerState,
    private readonly statePath: string,
    private readonly claudeCommand: string,
    private readonly reportActivity: WorkerActivityReporter = reportToTerminal,
    private readonly runTurn: typeof runClaudeTurn = runClaudeTurn,
    options: VirtualClaudeAgentOptions = {},
  ) {
    this.sessionId = agent.sessionId ?? state.agents[agent.id]?.sessionId ?? null;
    this.client = options.client ?? new IntercomClient();
    this.prepareConnection = options.prepareConnection ?? (async () => {
      const config = loadConfig();
      await spawnBrokerIfNeeded(config.brokerCommand, config.brokerArgs);
    });
    this.reconnectDelays = options.reconnectDelays?.length ? options.reconnectDelays : [250, 500, 1000, 2000, 5000];
  }

  get id(): string {
    return this.agent.id;
  }

  async copyContact(): Promise<string> {
    const sessions = await this.client.listSessions();
    const current = sessions.find((session) => session.id === this.client.sessionId);
    const text = current ? formatContactInstruction(current, sessions) : `Intercom target: ${this.client.sessionId ?? this.agent.id}`;
    return copyTextToClipboard(text) ? `Copied ${text.replace(/\n/g, "; ")}` : `Clipboard unavailable. ${text.replace(/\n/g, "; ")}`;
  }

  async listPeers(): Promise<SessionInfo[]> {
    const sessions = await this.client.listSessions();
    return sessions.filter((session) => session.id !== this.client.sessionId);
  }

  async sendMessage(to: string, text: string): Promise<string> {
    const sessions = await this.client.listSessions();
    const normalized = to.toLowerCase();
    const matches = sessions.filter((session) =>
      session.id === to
      || session.id.startsWith(to)
      || session.name?.toLowerCase() === normalized
    );
    if (matches.length > 1) {
      throw new Error(`Multiple intercom sessions match "${to}"; choose a full ID.`);
    }
    const target = matches[0]?.id ?? to;
    const result = await this.client.send(target, { text });
    if (!result.delivered) {
      throw new Error(result.reason ?? `Intercom session "${to}" is unavailable.`);
    }
    return `Message sent to ${matches[0]?.name || to}.`;
  }

  async start(): Promise<void> {
    this.reconnectEnabled = true;
    this.client.on("message", (from: SessionInfo, message: Message, deliveryId: string) => {
      this.routeMessage(from, message);
      this.client.acknowledgeMessage(deliveryId);
    });
    this.client.on("error", (error: Error) => {
      process.stderr.write(`worker ${this.agent.id}: ${error.message}\n`);
    });
    this.client.on("disconnected", () => {
      this.scheduleReconnect();
    });
    await this.connectIntercom();
  }

  private async connectIntercom(): Promise<void> {
    this.clearReconnectTimer();
    if (this.client.isConnected()) return;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = (async () => {
      await this.prepareConnection();
      await this.client.connect({
        name: this.agent.name,
        cwd: this.agent.cwd,
        model: this.agent.model ?? "claude",
        pid: process.pid,
        startedAt: this.intercomStartedAt,
        lastActivity: Date.now(),
        status: "idle",
      }, this.agent.id);
      this.reconnectAttempt = 0;
    })();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  private scheduleReconnect(): void {
    if (!this.reconnectEnabled || this.reconnectTimer) return;
    const delay = this.reconnectDelays[Math.min(this.reconnectAttempt, this.reconnectDelays.length - 1)]!;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectIntercom().then(() => {
        if (!this.client.isConnected()) {
          this.reconnectAttempt += 1;
          this.scheduleReconnect();
        }
      }).catch((error) => {
        this.reconnectAttempt += 1;
        process.stderr.write(`worker ${this.agent.id}: reconnect failed: ${error instanceof Error ? error.message : String(error)}\n`);
        this.scheduleReconnect();
      });
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  async stop(): Promise<void> {
    this.reconnectEnabled = false;
    this.clearReconnectTimer();
    if (this.connectPromise) {
      try {
        await this.connectPromise;
      } catch {
        // A failed in-progress connection is already closed.
      }
    }
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
      this.reportActivity({ type: "started", agent: this.agent, from, message });

      const result = await this.runTurn({
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

      if (result.isError) {
        const text = result.result || "Claude exited with an error and no message";
        this.client.updatePresence({ status: `error: ${text}` });
        this.reportActivity({ type: "error", agent: this.agent, from, message, error: text });
      } else {
        this.client.updatePresence({ status: "idle" });
        this.reportActivity({
          type: "completed",
          agent: this.agent,
          from,
          message,
          result: result.result,
          sessionId: this.sessionId,
        });
      }

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
      this.reportActivity({ type: "error", agent: this.agent, from, message, error: text });
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

  constructor(
    private readonly config: WorkerConfig,
    private readonly reportActivity: WorkerActivityReporter = reportToTerminal,
  ) {}

  async start(): Promise<void> {
    const intercomConfig = loadConfig();
    await spawnBrokerIfNeeded(intercomConfig.brokerCommand, intercomConfig.brokerArgs);
    const state = loadWorkerState(this.config.statePath);
    const claudeCommand = this.config.claudeCommand ?? "claude";
    this.agents = this.config.agents.map((agent) => new VirtualClaudeAgent(
      agent,
      state,
      this.config.statePath,
      claudeCommand,
      this.reportActivity,
    ));
    for (const agent of this.agents) await agent.start();
    process.stderr.write(`claude-intercom worker running ${this.agents.length} agent(s)\n`);
  }

  async stop(): Promise<void> {
    for (const agent of this.agents) await agent.stop().catch(() => undefined);
  }

  async copyPrimaryContact(): Promise<string> {
    if (!this.agents[0]) throw new Error("No Claude intercom agent is running");
    return this.agents[0].copyContact();
  }

  async listPrimaryPeers(): Promise<SessionInfo[]> {
    if (!this.agents[0]) throw new Error("No Claude intercom agent is running");
    return this.agents[0].listPeers();
  }

  async sendFromPrimary(to: string, text: string): Promise<string> {
    if (!this.agents[0]) throw new Error("No Claude intercom agent is running");
    return this.agents[0].sendMessage(to, text);
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
