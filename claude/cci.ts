import { once } from "node:events";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, resolve } from "node:path";
import { ClaudeWorkerDaemon } from "./worker-daemon.ts";
import { DEFAULT_WORKER_STATE_PATH, type WorkerAgentConfig, type WorkerConfig } from "./worker-config.ts";

export interface CciOptions {
  id?: string;
  name?: string;
  cwd: string;
  instructions?: string;
  model?: string;
  statePath?: string;
  permissionMode?: string;
  dangerouslySkipPermissions: boolean;
  addDirs: string[];
  mcpConfig?: string;
  minimal: boolean;
  claudeCommand: string;
}

interface IdentityInput {
  cwd: string;
  pid: number;
  gitRoot?: string | null;
  branch?: string | null;
}

export function sanitizeSegment(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase() || "claude";
}

function shortHash(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 8);
}

function gitString(cwd: string, args: string[]): string | null {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return null;
  const trimmed = result.stdout.trim();
  return trimmed || null;
}

export function createDefaultIdentity(input: IdentityInput): { id: string; name: string } {
  const root = input.gitRoot || input.cwd;
  const repo = basename(root) || "claude";
  const branch = input.branch || "worktree";
  const readable = `${repo}:${branch}`;
  const suffix = `${shortHash(input.cwd)}-${input.pid}`;
  return {
    id: sanitizeSegment(`claude-${repo}-${branch}-${suffix}`),
    name: `claude:${readable}#${input.pid}`,
  };
}

function detectIdentity(cwd: string): { id: string; name: string } {
  return createDefaultIdentity({
    cwd,
    pid: process.pid,
    gitRoot: gitString(cwd, ["rev-parse", "--show-toplevel"]),
    branch: gitString(cwd, ["branch", "--show-current"]),
  });
}

function readValue(args: string[], index: number, option: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

export function parseCciArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): CciOptions {
  const options: Partial<CciOptions> & { addDirs: string[] } = { addDirs: [] };
  let dangerouslySkipPermissions: boolean | undefined;
  let minimal = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const [key, inlineValue] = arg.includes("=") ? arg.split(/=(.*)/s, 2) : [arg, undefined];
    const value = inlineValue ?? null;

    switch (key) {
      case "--name":
        options.name = value ?? readValue(argv, index++, key);
        break;
      case "--id":
        options.id = value ?? readValue(argv, index++, key);
        break;
      case "--cwd":
        options.cwd = resolve(value ?? readValue(argv, index++, key));
        break;
      case "--instructions":
        options.instructions = value ?? readValue(argv, index++, key);
        break;
      case "--model":
        options.model = value ?? readValue(argv, index++, key);
        break;
      case "--state":
        options.statePath = resolve(value ?? readValue(argv, index++, key));
        break;
      case "--permission-mode":
        options.permissionMode = value ?? readValue(argv, index++, key);
        break;
      case "--add-dir":
        options.addDirs.push(resolve(value ?? readValue(argv, index++, key)));
        break;
      case "--mcp-config":
        options.mcpConfig = value ?? readValue(argv, index++, key);
        break;
      case "--claude":
        options.claudeCommand = value ?? readValue(argv, index++, key);
        break;
      case "--yolo":
      case "--dangerously-skip-permissions":
        dangerouslySkipPermissions = true;
        break;
      case "--safe":
        dangerouslySkipPermissions = false;
        options.permissionMode = options.permissionMode ?? "default";
        break;
      case "--minimal":
      case "--bare":
        minimal = true;
        break;
      default:
        break;
    }
  }

  return {
    cwd: resolve(options.cwd ?? env.CLAUDE_INTERCOM_CWD ?? process.cwd()),
    id: options.id ?? env.CLAUDE_INTERCOM_SESSION_ID,
    name: options.name ?? env.CLAUDE_INTERCOM_NAME,
    instructions: options.instructions ?? env.CLAUDE_INTERCOM_INSTRUCTIONS,
    model: options.model ?? env.CLAUDE_INTERCOM_MODEL,
    statePath: options.statePath,
    permissionMode: dangerouslySkipPermissions ? undefined : options.permissionMode,
    dangerouslySkipPermissions: dangerouslySkipPermissions ?? true,
    addDirs: options.addDirs,
    mcpConfig: options.mcpConfig,
    minimal,
    claudeCommand: options.claudeCommand || env.CLAUDE_INTERCOM_CLAUDE_COMMAND || "claude",
  };
}

export async function runCci(options: CciOptions): Promise<number> {
  const identity = detectIdentity(options.cwd);
  const id = sanitizeSegment(options.id ?? identity.id);
  const name = options.name ?? identity.name;
  const statePath = options.statePath ?? DEFAULT_WORKER_STATE_PATH;

  // Minimal mode runs each woken turn with Claude Code's --safe-mode, which
  // disables CLAUDE.md, skills, plugins, hooks, MCP servers, and *custom* agent
  // definitions while keeping auth, built-in tools, and permissions working
  // normally — the focused-worker analog of the Codex minimal profile. The
  // built-in Task tool is retained, so a minimal worker can still delegate to
  // general-purpose subagents (matching Codex minimal's multi_agent = true).
  const claudeArgs = options.minimal ? ["--safe-mode"] : undefined;

  const agent: WorkerAgentConfig = {
    id,
    name,
    cwd: options.cwd,
    model: options.model,
    instructions: options.instructions,
    permissionMode: options.permissionMode,
    dangerouslySkipPermissions: options.dangerouslySkipPermissions,
    addDirs: options.addDirs.length ? options.addDirs : undefined,
    mcpConfig: options.mcpConfig,
    claudeArgs,
  };

  const config: WorkerConfig = {
    statePath,
    claudeCommand: options.claudeCommand,
    agents: [agent],
  };

  process.stderr.write(`cci intercom worker: ${name} (${id})\n`);
  process.stderr.write(`Resume this worker's Claude session anytime with: claude --resume <session-id> (see ${statePath} once a turn has run)\n`);
  if (options.dangerouslySkipPermissions) {
    process.stderr.write("Running with --dangerously-skip-permissions (yolo). Pass --safe to opt out.\n");
  }
  if (options.minimal) {
    process.stderr.write("Minimal mode: woken turns run with --safe-mode (no CLAUDE.md, skills, plugins, hooks, or MCP). Built-in tools and subagent delegation (Task tool) are retained.\n");
  }

  const daemon = new ClaudeWorkerDaemon(config);
  let cleaned = false;
  const cleanupOnce = async () => {
    if (cleaned) return;
    cleaned = true;
    await daemon.stop().catch(() => undefined);
  };

  process.once("SIGINT", () => {
    void cleanupOnce().finally(() => process.exit(130));
  });
  process.once("SIGTERM", () => {
    void cleanupOnce().finally(() => process.exit(143));
  });

  await daemon.start();
  let restoreInput: (() => void) | undefined;
  if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const onData = (chunk: Buffer) => {
      const input = chunk.toString("utf8");
      if (input === "\u001bi" || input === "\u001bI") {
        void daemon.copyPrimaryContact().then((status) => process.stderr.write(`${status}\n`));
      } else if (input === "\u0003") {
        process.emit("SIGINT");
      }
    };
    process.stdin.on("data", onData);
    restoreInput = () => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    };
    process.stderr.write("Press Alt+I to copy this worker's intercom contact target.\n");
  }
  await Promise.race([once(process, "SIGINT"), once(process, "SIGTERM")]);
  restoreInput?.();
  await cleanupOnce();
  return 0;
}

async function main(): Promise<void> {
  const options = parseCciArgs(process.argv.slice(2));
  const code = await runCci(options);
  process.exit(code);
}

// Resolve the invoked path through realpath: when installed as an npm bin,
// process.argv[1] is the symlink (e.g. .../bin/cci) whose basename lacks the
// .mjs suffix, so match against the real bundle file (dist/cci.mjs) instead.
function invokedFileBasename(): string {
  try {
    return process.argv[1] ? basename(realpathSync(process.argv[1])) : "";
  } catch {
    return process.argv[1] ? basename(process.argv[1]) : "";
  }
}

if (invokedFileBasename() === "cci.ts" || invokedFileBasename() === "cci.mjs") {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}
