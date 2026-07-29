import { spawn } from "node:child_process";
import {
  assertNoPermissionOverrides,
  bindHardenedClaudePaths,
  resolveClaudePermissionPolicy,
  type ClaudePermissionCeiling,
  type ClaudePermissionMode,
} from "./permission-policy.ts";

export interface ClaudeTurnOptions {
  prompt: string;
  cwd: string;
  sessionId?: string;
  model?: string;
  appendSystemPrompt?: string;
  permissionMode?: ClaudePermissionMode;
  dangerouslySkipPermissions?: boolean;
  permissionCeiling?: ClaudePermissionCeiling;
  addDirs?: string[];
  mcpConfig?: string;
  claudeCommand?: string;
  extraArgs?: string[];
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface ClaudeTurnResult {
  sessionId: string | null;
  result: string;
  isError: boolean;
  raw: unknown;
}

interface PreparedClaudeLaunch {
  args: string[];
  cwd: string;
  release(): void;
}

function prepareClaudeLaunch(options: ClaudeTurnOptions): PreparedClaudeLaunch {
  const args: string[] = ["-p", "--output-format", "json"];
  const permission = resolveClaudePermissionPolicy({
    permissionMode: options.permissionMode,
    dangerouslySkipPermissions: options.dangerouslySkipPermissions,
    ceiling: options.permissionCeiling,
  });
  assertNoPermissionOverrides(options.extraArgs ?? [], "extraArgs", permission.ceiling);

  let cwd = options.cwd;
  let addDirs = options.addDirs ?? [];
  let release = () => {};
  if (permission.ceiling === "read-only") {
    if (options.mcpConfig !== undefined) {
      throw new Error("mcpConfig cannot add an arbitrary MCP capability to a hardened Claude role");
    }
    const binding = bindHardenedClaudePaths(options.cwd, addDirs);
    cwd = binding.cwd;
    addDirs = binding.addDirs;
    release = binding.release;
    // --bare prevents ambient project/user customizations and hooks from
    // widening a hardened launch. Explicit broker-owned inputs are appended
    // below after the permission boundary has been fixed.
    args.push("--bare");
  }

  if (options.sessionId) {
    args.push("--resume", options.sessionId);
  }
  if (options.model) {
    args.push("--model", options.model);
  }
  if (options.appendSystemPrompt) {
    args.push("--append-system-prompt", options.appendSystemPrompt);
  }
  if (permission.dangerouslySkipPermissions) {
    args.push("--dangerously-skip-permissions");
  } else if (permission.permissionMode && (
    permission.ceiling === "read-only" || options.permissionMode !== undefined
  )) {
    args.push("--permission-mode", permission.permissionMode);
  }
  for (const dir of addDirs) {
    args.push("--add-dir", dir);
  }
  if (options.mcpConfig) {
    args.push("--mcp-config", options.mcpConfig);
  }
  if (options.extraArgs?.length) {
    args.push(...options.extraArgs);
  }

  return { args, cwd, release };
}

export function buildClaudeArgs(options: ClaudeTurnOptions): string[] {
  const launch = prepareClaudeLaunch(options);
  try {
    return launch.args;
  } finally {
    launch.release();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function runClaudeTurn(options: ClaudeTurnOptions): Promise<ClaudeTurnResult> {
  return new Promise((resolve, reject) => {
    const command = options.claudeCommand ?? "claude";
    const launch = prepareClaudeLaunch(options);
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, launch.args, {
        cwd: launch.cwd,
        env: { ...process.env, ...options.env },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } finally {
      // Directory descriptors remain open across the synchronous spawn setup,
      // narrowing replacement races without leaking them for the turn.
      launch.release();
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeoutHandle: NodeJS.Timeout | undefined;

    const cleanup = () => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      options.signal?.removeEventListener("abort", onAbort);
    };

    const finishReject = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const finishResolve = (result: ClaudeTurnResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const onAbort = () => {
      child.kill("SIGTERM");
      finishReject(new Error("Claude turn aborted"));
    };

    if (options.signal) {
      if (options.signal.aborted) {
        child.kill("SIGTERM");
        finishReject(new Error("Claude turn aborted"));
        return;
      }
      options.signal.addEventListener("abort", onAbort, { once: true });
    }

    if (options.timeoutMs) {
      timeoutHandle = setTimeout(() => {
        child.kill("SIGTERM");
        finishReject(new Error(`Claude turn timed out after ${options.timeoutMs}ms`));
      }, options.timeoutMs);
    }

    child.on("error", (error) => {
      finishReject(new Error(`Failed to spawn "${command}": ${error.message}`, { cause: error }));
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("close", (exitCode) => {
      if (settled) return;

      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout.trim());
      } catch {
        const fallback = stdout.trim() || stderr.trim();
        finishResolve({
          sessionId: options.sessionId ?? null,
          result: fallback,
          isError: exitCode !== 0,
          raw: stdout,
        });
        return;
      }

      if (isRecord(parsed) && typeof parsed.result === "string") {
        finishResolve({
          sessionId: typeof parsed.session_id === "string" ? parsed.session_id : null,
          result: parsed.result,
          isError: Boolean(parsed.is_error),
          raw: parsed,
        });
        return;
      }

      finishResolve({
        sessionId: options.sessionId ?? null,
        result: stdout.trim(),
        isError: exitCode !== 0,
        raw: parsed,
      });
    });

    child.stdin?.write(options.prompt);
    child.stdin?.end();
  });
}
