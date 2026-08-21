import { spawnSync } from "node:child_process";

export const CLAUDE_INTERCOM_TRANSPORT_ENV = "CLAUDE_INTERCOM_TRANSPORT";
export const MIN_NATIVE_CLAUDE_VERSION = "2.1.220";

export type ClaudeIntercomTransport = "auto" | "native" | "mcp";
export type ResolvedClaudeIntercomTransport = Exclude<ClaudeIntercomTransport, "auto">;

export interface ClaudeVersionProbe {
  command: string;
  version: string | null;
  compatible: boolean;
  reason: string;
}

export interface ClaudeTransportResolution extends ClaudeVersionProbe {
  requested: ClaudeIntercomTransport;
  selected: ResolvedClaudeIntercomTransport;
}

export function parseClaudeIntercomTransport(value: unknown, source = "transport"): ClaudeIntercomTransport {
  if (value === undefined || value === null || value === "") return "auto";
  if (value === "auto" || value === "native" || value === "mcp") return value;
  throw new Error(`${source} must be one of auto, native, or mcp`);
}

export function parseClaudeVersion(output: string): string | null {
  const match = output.match(/(?:^|\s)(\d+\.\d+\.\d+)(?:\s|$)/);
  return match?.[1] ?? null;
}

function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function isNativeClaudeVersionCompatible(version: string): boolean {
  return compareVersions(version, MIN_NATIVE_CLAUDE_VERSION) >= 0;
}

export function probeClaudeVersion(command = "claude"): ClaudeVersionProbe {
  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) {
    return {
      command,
      version: null,
      compatible: false,
      reason: `could not run ${command} --version`,
    };
  }
  const version = parseClaudeVersion(`${result.stdout}\n${result.stderr}`);
  if (!version) {
    return { command, version: null, compatible: false, reason: "Claude version output was not recognized" };
  }
  const compatible = isNativeClaudeVersionCompatible(version);
  return {
    command,
    version,
    compatible,
    reason: compatible
      ? `Claude ${version} meets the native transport minimum version ${MIN_NATIVE_CLAUDE_VERSION}`
      : `Claude ${version} is below the native transport minimum version ${MIN_NATIVE_CLAUDE_VERSION}`,
  };
}

export function resolveClaudeIntercomTransport(options: {
  requested?: ClaudeIntercomTransport | string;
  env?: NodeJS.ProcessEnv;
  claudeCommand?: string;
  probe?: (command: string) => ClaudeVersionProbe;
} = {}): ClaudeTransportResolution {
  const requested = parseClaudeIntercomTransport(
    options.requested ?? options.env?.[CLAUDE_INTERCOM_TRANSPORT_ENV] ?? "auto",
    options.requested === undefined ? CLAUDE_INTERCOM_TRANSPORT_ENV : "transport",
  );
  const command = options.claudeCommand || "claude";
  const versionProbe = (options.probe ?? probeClaudeVersion)(command);
  if (requested === "mcp") return { requested, selected: "mcp", ...versionProbe };
  if (requested === "native" && !versionProbe.compatible) {
    throw new Error(`Native Claude intercom transport was requested, but ${versionProbe.reason}. Use --transport mcp or install a verified-compatible Claude version.`);
  }
  return {
    requested,
    selected: requested === "native" || versionProbe.compatible ? "native" : "mcp",
    ...versionProbe,
  };
}
