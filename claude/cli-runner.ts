import { spawn } from "node:child_process";

export interface ClaudeTurnOptions {
  prompt: string;
  cwd: string;
  sessionId?: string;
  model?: string;
  appendSystemPrompt?: string;
  permissionMode?: string;
  dangerouslySkipPermissions?: boolean;
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

export function buildClaudeArgs(options: ClaudeTurnOptions): string[] {
  const args: string[] = ["-p", "--output-format", "json"];

  if (options.sessionId) {
    args.push("--resume", options.sessionId);
  }
  if (options.model) {
    args.push("--model", options.model);
  }
  if (options.appendSystemPrompt) {
    args.push("--append-system-prompt", options.appendSystemPrompt);
  }
  if (options.dangerouslySkipPermissions) {
    args.push("--dangerously-skip-permissions");
  } else if (options.permissionMode) {
    args.push("--permission-mode", options.permissionMode);
  }
  for (const dir of options.addDirs ?? []) {
    args.push("--add-dir", dir);
  }
  if (options.mcpConfig) {
    args.push("--mcp-config", options.mcpConfig);
  }
  if (options.extraArgs?.length) {
    args.push(...options.extraArgs);
  }

  return args;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function runClaudeTurn(options: ClaudeTurnOptions): Promise<ClaudeTurnResult> {
  return new Promise((resolve, reject) => {
    const command = options.claudeCommand ?? "claude";
    const args = buildClaudeArgs(options);
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

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
