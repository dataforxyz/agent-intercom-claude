import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { cwd as processCwd } from "node:process";
import { getIntercomDirPath, restrictIntercomRuntimeFile } from "../broker/paths.ts";
import { isDenseArrayOf } from "../broker/validation.ts";
import {
  assertNoPermissionOverrides,
  bindHardenedClaudePaths,
  resolveClaudePermissionPolicy,
  type ClaudePermissionCeiling,
  type ClaudePermissionMode,
} from "./permission-policy.ts";

export interface WorkerAgentConfig {
  id: string;
  name: string;
  cwd: string;
  model?: string;
  sessionId?: string;
  instructions?: string;
  permissionMode?: ClaudePermissionMode;
  dangerouslySkipPermissions?: boolean;
  permissionCeiling?: ClaudePermissionCeiling;
  /** Tightening-only role hint; authority still comes exclusively from the broker binding. */
  bossRole?: "adversary" | "council";
  addDirs?: string[];
  mcpConfig?: string;
  claudeArgs?: string[];
}

export interface WorkerConfig {
  agents: WorkerAgentConfig[];
  statePath: string;
  claudeCommand?: string;
}

export interface WorkerState {
  agents: Record<string, { sessionId: string; updatedAt: number }>;
}

export const DEFAULT_WORKER_CONFIG_PATH = join(getIntercomDirPath(), "claude-worker.json");
export const DEFAULT_WORKER_STATE_PATH = join(getIntercomDirPath(), "claude-worker-state.json");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const trimmed = value.trim();
  return trimmed || undefined;
}

function requireString(value: unknown, field: string): string {
  const result = optionalString(value, field);
  if (!result) throw new Error(`${field} must be a non-empty string`);
  return result;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
  return value;
}

function optionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isDenseArrayOf<unknown>(value, (_entry): _entry is unknown => true)) {
    throw new Error(`${field} must be an exact dense array`);
  }
  return value.map((item, index) => requireString(item, `${field}[${index}]`));
}

function normalizeAgent(raw: unknown, index: number): WorkerAgentConfig {
  if (!isRecord(raw)) throw new Error(`agents[${index}] must be an object`);
  const id = requireString(raw.id, `agents[${index}].id`);
  const name = optionalString(raw.name, `agents[${index}].name`) ?? id;
  const cwdValue = optionalString(raw.cwd, `agents[${index}].cwd`) ?? processCwd();
  let cwd = resolve(cwdValue);
  const permissionModeValue = optionalString(raw.permissionMode, `agents[${index}].permissionMode`);
  const dangerouslySkipPermissionsValue = optionalBoolean(
    raw.dangerouslySkipPermissions,
    `agents[${index}].dangerouslySkipPermissions`,
  );
  const permissionCeilingValue = optionalString(raw.permissionCeiling, `agents[${index}].permissionCeiling`);
  if (permissionCeilingValue !== undefined && permissionCeilingValue !== "standard" && permissionCeilingValue !== "read-only") {
    throw new Error(`agents[${index}].permissionCeiling must be standard or read-only`);
  }
  const bossRoleValue = optionalString(raw.bossRole, `agents[${index}].bossRole`);
  if (bossRoleValue !== undefined && bossRoleValue !== "adversary" && bossRoleValue !== "council") {
    throw new Error(`agents[${index}].bossRole must be adversary or council`);
  }
  if (bossRoleValue !== undefined && permissionCeilingValue === "standard") {
    throw new Error(`agents[${index}].permissionCeiling cannot widen an Adversary/Council role`);
  }
  const permission = resolveClaudePermissionPolicy({
    permissionMode: permissionModeValue,
    dangerouslySkipPermissions: dangerouslySkipPermissionsValue,
    ceiling: bossRoleValue === undefined
      ? permissionCeilingValue as ClaudePermissionCeiling | undefined
      : "read-only",
  });
  const claudeArgs = optionalStringArray(raw.claudeArgs, `agents[${index}].claudeArgs`);
  let addDirs = optionalStringArray(raw.addDirs, `agents[${index}].addDirs`);
  const mcpConfig = optionalString(raw.mcpConfig, `agents[${index}].mcpConfig`);
  assertNoPermissionOverrides(claudeArgs ?? [], `agents[${index}].claudeArgs`, permission.ceiling);
  if (permission.ceiling === "read-only") {
    if (mcpConfig !== undefined) {
      throw new Error(`agents[${index}].mcpConfig cannot add an arbitrary MCP capability to a hardened Claude role`);
    }
    const binding = bindHardenedClaudePaths(cwdValue, addDirs ?? [], `agents[${index}]`);
    try {
      cwd = binding.cwd;
      addDirs = binding.addDirs.length ? binding.addDirs : undefined;
    } finally {
      binding.release();
    }
  }
  return {
    id,
    name,
    cwd,
    model: optionalString(raw.model, `agents[${index}].model`),
    sessionId: optionalString(raw.sessionId, `agents[${index}].sessionId`),
    instructions: optionalString(raw.instructions, `agents[${index}].instructions`),
    ...(permission.ceiling === "standard" && permissionModeValue === undefined
      ? {}
      : { permissionMode: permission.permissionMode }),
    ...(dangerouslySkipPermissionsValue === undefined && permission.ceiling !== "read-only"
      ? {}
      : { dangerouslySkipPermissions: permission.dangerouslySkipPermissions }),
    ...(permissionCeilingValue === undefined && bossRoleValue === undefined
      ? {}
      : { permissionCeiling: permission.ceiling }),
    ...(bossRoleValue === undefined ? {} : { bossRole: bossRoleValue }),
    addDirs,
    mcpConfig,
    claudeArgs,
  };
}

export function defaultWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const id = env.CLAUDE_INTERCOM_WORKER_ID?.trim() || "claude-worker";
  return {
    statePath: env.CLAUDE_INTERCOM_WORKER_STATE?.trim() || DEFAULT_WORKER_STATE_PATH,
    agents: [{
      id,
      name: env.CLAUDE_INTERCOM_WORKER_NAME?.trim() || id,
      cwd: resolve(env.CLAUDE_INTERCOM_WORKER_CWD?.trim() || processCwd()),
      model: env.CLAUDE_INTERCOM_WORKER_MODEL?.trim() || undefined,
      instructions: env.CLAUDE_INTERCOM_WORKER_INSTRUCTIONS?.trim() || undefined,
    }],
  };
}

export function loadWorkerConfig(path = process.env.CLAUDE_INTERCOM_WORKER_CONFIG || DEFAULT_WORKER_CONFIG_PATH): WorkerConfig {
  if (!existsSync(path)) return defaultWorkerConfig();

  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(parsed)) throw new Error("Worker config must be a JSON object");
  if (!isDenseArrayOf<unknown>(parsed.agents, (_entry): _entry is unknown => true)) {
    throw new Error("Worker config requires an exact dense agents array");
  }

  return {
    statePath: resolve(optionalString(parsed.statePath, "statePath") ?? DEFAULT_WORKER_STATE_PATH),
    claudeCommand: optionalString(parsed.claudeCommand, "claudeCommand"),
    agents: parsed.agents.map(normalizeAgent),
  };
}

export function loadWorkerState(path: string): WorkerState {
  if (!existsSync(path)) return { agents: {} };
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(parsed) || !isRecord(parsed.agents)) return { agents: {} };
  const agents: WorkerState["agents"] = {};
  for (const [id, value] of Object.entries(parsed.agents)) {
    if (!isRecord(value) || typeof value.sessionId !== "string") continue;
    agents[id] = {
      sessionId: value.sessionId,
      updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : 0,
    };
  }
  return { agents };
}

export function saveWorkerState(path: string, state: WorkerState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  restrictIntercomRuntimeFile(path);
}
