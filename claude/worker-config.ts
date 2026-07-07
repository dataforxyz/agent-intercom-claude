import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { cwd as processCwd } from "node:process";
import { getIntercomDirPath, restrictIntercomRuntimeFile } from "../broker/paths.ts";

export interface WorkerAgentConfig {
  id: string;
  name: string;
  cwd: string;
  model?: string;
  sessionId?: string;
  instructions?: string;
  permissionMode?: string;
  dangerouslySkipPermissions?: boolean;
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
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value.map((item, index) => requireString(item, `${field}[${index}]`));
}

function normalizeAgent(raw: unknown, index: number): WorkerAgentConfig {
  if (!isRecord(raw)) throw new Error(`agents[${index}] must be an object`);
  const id = requireString(raw.id, `agents[${index}].id`);
  const name = optionalString(raw.name, `agents[${index}].name`) ?? id;
  return {
    id,
    name,
    cwd: resolve(optionalString(raw.cwd, `agents[${index}].cwd`) ?? processCwd()),
    model: optionalString(raw.model, `agents[${index}].model`),
    sessionId: optionalString(raw.sessionId, `agents[${index}].sessionId`),
    instructions: optionalString(raw.instructions, `agents[${index}].instructions`),
    permissionMode: optionalString(raw.permissionMode, `agents[${index}].permissionMode`),
    dangerouslySkipPermissions: optionalBoolean(raw.dangerouslySkipPermissions, `agents[${index}].dangerouslySkipPermissions`),
    addDirs: optionalStringArray(raw.addDirs, `agents[${index}].addDirs`),
    mcpConfig: optionalString(raw.mcpConfig, `agents[${index}].mcpConfig`),
    claudeArgs: optionalStringArray(raw.claudeArgs, `agents[${index}].claudeArgs`),
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
  if (!Array.isArray(parsed.agents)) throw new Error("Worker config requires an agents array");

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
