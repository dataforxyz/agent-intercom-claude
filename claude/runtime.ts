import { randomUUID, createHash } from "crypto";
import { spawnSync } from "child_process";
import { basename } from "path";
import { cwd as processCwd } from "process";
import { IntercomClient } from "../broker/client.ts";
import { spawnBrokerIfNeeded } from "../broker/spawn.ts";
import { getAskTimeoutMs, loadConfig } from "../config.ts";
import { appendInboxMessage } from "./inbox.ts";
import type { Attachment, Message, SessionInfo } from "../types.ts";
import { formatIntercomTeam, resolveIntercomTeam } from "./team.ts";

export interface ClaudeRuntimeIdentity {
  sessionId: string;
  name: string;
  cwd: string;
  model: string;
  startedAt: number;
}

export interface PendingInboundMessage {
  from: SessionInfo;
  message: Message;
  receivedAt: number;
  read: boolean;
}

export type ReplyWhich = "oldest" | "latest";

function matchesPendingSender(entry: PendingInboundMessage, to: string): boolean {
  return entry.from.id === to
    || entry.from.name?.toLowerCase() === to.toLowerCase()
    || entry.from.id.startsWith(to);
}

export function selectPendingAsk(entries: PendingInboundMessage[], to?: string, which?: ReplyWhich): PendingInboundMessage {
  const sorted = [...entries].sort((a, b) => a.receivedAt - b.receivedAt);
  if (sorted.length === 0) throw new Error("No matching pending ask. Call intercom_pending to inspect unresolved asks.");
  const matches = to ? sorted.filter((entry) => matchesPendingSender(entry, to)) : sorted;
  if (matches.length === 0) throw new Error(`No pending ask from "${to}".`);
  if (matches.length === 1) return matches[0]!;
  if (!to && new Set(matches.map((entry) => entry.from.id)).size > 1) {
    throw new Error("Multiple pending asks — specify `to` using a sender from intercom_pending.");
  }
  if (!which) {
    const sender = to ? ` from "${to}"` : "";
    throw new Error(`Multiple pending asks${sender} — specify \`which\` as \`oldest\` or \`latest\`.`);
  }
  return which === "oldest" ? matches[0]! : matches[matches.length - 1]!;
}

function pendingSelector(entries: PendingInboundMessage[], entry: PendingInboundMessage): "oldest" | "latest" | "queued" | undefined {
  const sameSender = entries.filter((candidate) => candidate.from.id === entry.from.id);
  if (sameSender.length <= 1) return undefined;
  const index = sameSender.findIndex((candidate) => candidate.message.id === entry.message.id);
  if (index === 0) return "oldest";
  if (index === sameSender.length - 1) return "latest";
  return "queued";
}

function publicPendingEntry(entry: PendingInboundMessage, selector?: string): Record<string, unknown> {
  return {
    from: { id: entry.from.id, name: entry.from.name },
    received_at: entry.receivedAt,
    read: entry.read,
    text: entry.message.content.text,
    attachments: entry.message.content.attachments,
    expects_reply: entry.message.expectsReply,
    ...(selector ? { selector } : {}),
  };
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

interface ReplyWaiter {
  from: string;
  replyTo: string;
  resolve: (message: Message) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  cleanup?: () => void;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

export function buildClaudeRuntimeIdentity(env: NodeJS.ProcessEnv = process.env, cwd = env.PWD || processCwd(), pid = process.pid): ClaudeRuntimeIdentity {
  const sessionId = env.CLAUDE_INTERCOM_SESSION_ID?.trim()
    || env.CLAUDE_PEER_ID?.trim()
    || `claude-${pid}-${shortHash(cwd)}`;
  const cwdName = basename(cwd) || "workspace";
  const name = env.CLAUDE_INTERCOM_NAME?.trim()
    || env.CLAUDE_PEER_NAME?.trim()
    || `claude-${cwdName}-${pid}`;
  return {
    sessionId,
    name,
    cwd,
    model: env.CLAUDE_INTERCOM_MODEL?.trim() || env.CLAUDE_MODEL?.trim() || "claude",
    startedAt: Date.now(),
  };
}

export function formatAttachments(attachments: Attachment[] | undefined): string {
  if (!attachments?.length) return "";
  return attachments.map((attachment) => {
    if (attachment.language) {
      return `\n\n---\nAttachment: ${attachment.name}\n~~~${attachment.language}\n${attachment.content}\n~~~`;
    }
    return `\n\n---\nAttachment: ${attachment.name}\n${attachment.content}`;
  }).join("");
}

export function resolveSessionTarget(sessions: SessionInfo[], nameOrId: string): string | null {
  const byId = sessions.find((session) => session.id === nameOrId);
  if (byId) return byId.id;

  const lowerName = nameOrId.toLowerCase();
  const byName = sessions.filter((session) => session.name?.toLowerCase() === lowerName);
  if (byName.length > 1) {
    throw new Error(`Multiple sessions named "${nameOrId}" are connected. Use the session ID instead.`);
  }
  if (byName[0]) return byName[0].id;

  if (nameOrId.length >= 4) {
    const byPrefix = sessions.filter((session) => session.id.startsWith(nameOrId));
    if (byPrefix.length > 1) {
      throw new Error(`Multiple sessions match the ID prefix "${nameOrId}". Use the full session ID or a unique name.`);
    }
    if (byPrefix[0]) return byPrefix[0].id;
  }

  return null;
}

export function formatSessionList(sessions: SessionInfo[], currentSessionId: string | null, currentCwd: string): string {
  if (!sessions.length) return "No intercom sessions connected.";
  return sessions.map((session) => {
    const tags = [
      session.id === currentSessionId ? "self" : undefined,
      session.cwd === currentCwd ? "same cwd" : undefined,
      session.status,
    ].filter((tag): tag is string => Boolean(tag));
    const suffix = tags.length ? ` [${tags.join(", ")}]` : "";
    return `- ${session.name || "unnamed"} (${session.id.slice(0, 8)}) - ${session.cwd} (${session.model})${suffix}`;
  }).join("\n");
}

export function detectGitRoot(cwd: string): string | null {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}

function textResult(text: string, structuredContent?: Record<string, unknown>, isError = false): ToolResult {
  return {
    content: [{ type: "text", text }],
    ...(structuredContent ? { structuredContent } : {}),
    ...(isError ? { isError: true } : {}),
  };
}

export interface ClaudeIntercomRuntimeOptions {
  clientFactory?: () => IntercomClient;
  prepareConnection?: () => Promise<void>;
  reconnectDelays?: number[];
}

export class ClaudeIntercomRuntime {
  private client: IntercomClient | null = null;
  private connectPromise: Promise<IntercomClient> | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private reconnectEnabled = true;
  private identity: ClaudeRuntimeIdentity;
  private unread: PendingInboundMessage[] = [];
  private unresolvedAsks = new Map<string, PendingInboundMessage>();
  private replyWaiters = new Map<string, ReplyWaiter>();

  private readonly clientFactory: () => IntercomClient;
  private readonly prepareConnection: () => Promise<void>;
  private readonly reconnectDelays: number[];

  constructor(identity: ClaudeRuntimeIdentity = buildClaudeRuntimeIdentity(), options: ClaudeIntercomRuntimeOptions = {}) {
    this.identity = identity;
    this.clientFactory = options.clientFactory ?? (() => new IntercomClient());
    this.prepareConnection = options.prepareConnection ?? (async () => {
      const config = loadConfig();
      if (!config.enabled) throw new Error("Intercom disabled");
      await spawnBrokerIfNeeded(config.brokerCommand, config.brokerArgs);
    });
    this.reconnectDelays = options.reconnectDelays?.length ? options.reconnectDelays : [250, 500, 1000, 2000, 5000];
  }

  getIdentity(): ClaudeRuntimeIdentity {
    return this.identity;
  }

  async connect(): Promise<IntercomClient> {
    this.reconnectEnabled = true;
    this.clearReconnectTimer();
    if (this.client?.isConnected()) return this.client;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.connectOnce();
    try {
      return await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  private async connectOnce(): Promise<IntercomClient> {
    await this.prepareConnection();
    const client = this.clientFactory();
    client.on("message", (from: SessionInfo, message: Message, deliveryId: string) => {
      this.handleIncomingMessage(from, message);
      client.acknowledgeMessage(deliveryId);
    });
    client.on("disconnected", (error: Error) => {
      for (const waiter of this.replyWaiters.values()) {
        clearTimeout(waiter.timeout);
        waiter.cleanup?.();
        waiter.reject(new Error(`Disconnected while waiting for reply: ${error.message}`, { cause: error }));
      }
      this.replyWaiters.clear();
      if (this.client === client) this.client = null;
      this.scheduleReconnect();
    });
    await client.connect({
      name: this.identity.name,
      cwd: this.identity.cwd,
      model: this.identity.model,
      pid: process.pid,
      startedAt: this.identity.startedAt,
      lastActivity: Date.now(),
      status: "idle",
    }, this.identity.sessionId);
    this.client = client;
    this.reconnectAttempt = 0;
    return client;
  }

  private scheduleReconnect(): void {
    if (!this.reconnectEnabled || this.reconnectTimer) return;
    const delay = this.reconnectDelays[Math.min(this.reconnectAttempt, this.reconnectDelays.length - 1)]!;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().then((client) => {
        if (!client.isConnected()) {
          this.reconnectAttempt += 1;
          this.scheduleReconnect();
        }
      }).catch(() => {
        this.reconnectAttempt += 1;
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

  async disconnect(): Promise<void> {
    this.reconnectEnabled = false;
    this.clearReconnectTimer();
    if (this.connectPromise) {
      try {
        await this.connectPromise;
      } catch {
        // A failed in-progress connection is already closed.
      }
    }
    const client = this.client;
    this.client = null;
    if (client) await client.disconnect();
  }

  private handleIncomingMessage(from: SessionInfo, message: Message): void {
    const waiter = this.replyWaiters.get(message.replyTo ?? "");
    if (waiter) {
      const senderTarget = from.name || from.id;
      const fromMatches = senderTarget.toLowerCase() === waiter.from.toLowerCase() || from.id === waiter.from;
      if (fromMatches) {
        this.replyWaiters.delete(waiter.replyTo);
        clearTimeout(waiter.timeout);
        waiter.cleanup?.();
        waiter.resolve(message);
        return;
      }
    }

    const entry = { from, message, receivedAt: Date.now(), read: false };
    this.unread.push(entry);
    if (message.expectsReply) {
      this.unresolvedAsks.set(message.id, entry);
    }

    // TUI mode: mirror the message to the session inbox so the plugin monitor
    // can inject it into the live interactive session. Never let inbox I/O
    // break normal message handling.
    const inboxPath = process.env.CLAUDE_INTERCOM_INBOX;
    if (inboxPath) {
      try {
        appendInboxMessage(inboxPath, from, message);
      } catch {
        // Best-effort delivery mirror only.
      }
    }
  }

  private waitForReply(from: string, replyTo: string, timeoutMs = getAskTimeoutMs(), signal?: AbortSignal): Promise<Message> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("intercom_ask cancelled"));
        return;
      }
      let timeout: NodeJS.Timeout;
      const cleanup = () => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        this.replyWaiters.delete(replyTo);
        cleanup();
        void this.client?.cancelAsk(replyTo);
        reject(new Error("intercom_ask cancelled"));
      };
      timeout = setTimeout(() => {
        this.replyWaiters.delete(replyTo);
        void this.client?.deferAsk(replyTo);
        signal?.removeEventListener("abort", onAbort);
        reject(new Error(`No reply from "${from}" within ${Math.round(timeoutMs / 1000)} seconds`));
      }, timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.replyWaiters.set(replyTo, { from, replyTo, resolve, reject, timeout, cleanup });
    });
  }

  private async resolveTarget(to: string): Promise<string> {
    const client = await this.connect();
    const sessions = await client.listSessions();
    return resolveSessionTarget(sessions, to) ?? to;
  }

  async whoami(): Promise<ToolResult> {
    const client = await this.connect();
    const sessionId = client.sessionId ?? this.identity.sessionId;
    return textResult(
      `session_id: ${sessionId}\nname: ${this.identity.name}\ncwd: ${this.identity.cwd}`,
      { session_id: sessionId, name: this.identity.name, cwd: this.identity.cwd, model: this.identity.model },
    );
  }

  async team(): Promise<ToolResult> {
    const client = await this.connect();
    const sessions = await client.listSessions();
    const team = await resolveIntercomTeam({ selfId: client.sessionId ?? this.identity.sessionId, sessions });
    return textResult(formatIntercomTeam(team), team as unknown as Record<string, unknown>);
  }

  async status(): Promise<ToolResult> {
    const client = await this.connect();
    const sessions = await client.listSessions();
    return textResult(
      `Connected: ${client.isConnected() ? "Yes" : "No"}\nSession ID: ${client.sessionId ?? "unknown"}\nActive sessions: ${sessions.length}\nUnread messages: ${this.unread.filter((entry) => !entry.read).length}\nPending asks: ${this.unresolvedAsks.size}`,
      {
        connected: client.isConnected(),
        session_id: client.sessionId,
        active_sessions: sessions.length,
        unread_messages: this.unread.filter((entry) => !entry.read).length,
        pending_asks: this.unresolvedAsks.size,
      },
    );
  }

  async list(scope: "machine" | "directory" | "repo" = "machine", includeSelf = false): Promise<ToolResult> {
    const client = await this.connect();
    let sessions = await client.listSessions();
    if (scope === "directory") {
      sessions = sessions.filter((session) => session.cwd === this.identity.cwd);
    } else if (scope === "repo") {
      const currentRoot = detectGitRoot(this.identity.cwd);
      sessions = currentRoot
        ? sessions.filter((session) => detectGitRoot(session.cwd) === currentRoot)
        : [];
    }
    if (!includeSelf) {
      sessions = sessions.filter((session) => session.id !== client.sessionId);
    }
    return textResult(formatSessionList(sessions, client.sessionId, this.identity.cwd), { sessions });
  }

  async setSummary(summary: string): Promise<ToolResult> {
    const client = await this.connect();
    client.updatePresence({ status: summary.trim() || "idle" });
    return textResult("Summary updated.", { ok: true, summary });
  }

  async send(to: string, message: string, attachments?: Attachment[], replyTo?: string): Promise<ToolResult> {
    const client = await this.connect();
    const sendTo = await this.resolveTarget(to);
    const result = await client.send(sendTo, { text: message, attachments, replyTo });
    if (!result.delivered) {
      return textResult(`Message to "${to}" was not delivered: ${result.reason ?? "Session may not exist or has disconnected."}`, { ok: false, message_id: result.id, reason: result.reason }, true);
    }
    if (replyTo) this.unresolvedAsks.delete(replyTo);
    return textResult(`Message sent to ${to}.`, { ok: true, message_id: result.id, to });
  }

  async ask(to: string, message: string, attachments?: Attachment[], timeoutMs = getAskTimeoutMs(), signal?: AbortSignal): Promise<ToolResult> {
    const client = await this.connect();
    const sendTo = await this.resolveTarget(to);
    const questionId = randomUUID();
    const replyPromise = this.waitForReply(sendTo, questionId, timeoutMs, signal);
    void replyPromise.catch(() => undefined);
    try {
      const result = await client.send(sendTo, {
        messageId: questionId,
        text: message,
        attachments,
        expectsReply: true,
      });
      if (!result.delivered) {
        this.replyWaiters.get(questionId)?.reject(new Error(result.reason ?? "Session may not exist or has disconnected."));
        this.replyWaiters.delete(questionId);
        void client.cancelAsk(questionId);
        return textResult(`Message to "${to}" was not delivered: ${result.reason ?? "Session may not exist or has disconnected."}`, { ok: false, message_id: result.id, reason: result.reason }, true);
      }
      const reply = await replyPromise;
      const replyText = `${reply.content.text}${formatAttachments(reply.content.attachments)}`;
      return textResult(`Reply from ${to}:\n${replyText}`, { ok: true, message_id: result.id, reply });
    } catch (error) {
      void client.cancelAsk(questionId);
      return textResult(error instanceof Error ? error.message : String(error), { ok: false }, true);
    }
  }

  async pending(markRead = false): Promise<ToolResult> {
    const unreadMessages = this.unread.filter((entry) => !entry.read);
    if (markRead) {
      for (const entry of unreadMessages) entry.read = true;
    }
    const pendingAsks = Array.from(this.unresolvedAsks.values()).sort((a, b) => a.receivedAt - b.receivedAt);
    const lines = [
      unreadMessages.length
        ? unreadMessages.map((entry) => `- ${entry.from.name || entry.from.id}: ${entry.message.content.text}${formatAttachments(entry.message.content.attachments)}`).join("\n")
        : "No unread messages.",
      pendingAsks.length
        ? `\nPending asks:\n${pendingAsks.map((entry) => {
          const selector = pendingSelector(pendingAsks, entry);
          return `- ${entry.from.name || entry.from.id}${selector ? ` [${selector}]` : ""}: ${entry.message.content.text}`;
        }).join("\n")}`
        : "",
    ].filter(Boolean);
    return textResult(lines.join("\n"), {
      unread_messages: unreadMessages.map((entry) => publicPendingEntry(entry)),
      pending_asks: pendingAsks.map((entry) => publicPendingEntry(entry, pendingSelector(pendingAsks, entry))),
    });
  }

  async reply(message: string, to?: string, which?: ReplyWhich): Promise<ToolResult> {
    let target: PendingInboundMessage;
    try {
      target = selectPendingAsk(Array.from(this.unresolvedAsks.values()), to, which);
    } catch (error) {
      return textResult(error instanceof Error ? error.message : String(error), { ok: false }, true);
    }

    const result = await this.send(target.from.id, message, undefined, target.message.id);
    if (!result.isError) {
      this.unresolvedAsks.delete(target.message.id);
    }
    return result;
  }
}
