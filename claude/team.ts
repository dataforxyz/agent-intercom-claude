import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PARTICIPANT_STATES, TERMINAL_PARTICIPANT_STATES } from "@dataforxyz/agent-intercom-core/boss";
import type { BossSessionMetadata } from "../types.ts";
import { getAgentDirPath } from "../broker/paths.ts";

export interface TeamSession {
  id: string;
  name?: string;
  /** Already parsed and broker-authenticated by the client session decoder. */
  boss?: Pick<BossSessionMetadata, "binding" | "principal" | "liveWorker">;
}

interface StoredWorker {
  id?: unknown;
  runId?: unknown;
  workerIncarnationId?: unknown;
  workerGeneration?: unknown;
  bossRunId?: unknown;
  participantId?: unknown;
  bindingEpoch?: unknown;
  sessionId?: unknown;
  harness?: unknown;
  role?: unknown;
  state?: unknown;
  owned?: unknown;
  managerSessionId?: unknown;
  intercomTarget?: unknown;
}

export interface TeamMember {
  id: string;
  target: string;
  harness?: string;
  role?: string;
  state?: string;
  connected: boolean;
}

export interface IntercomTeam {
  teamId?: string;
  self: { id: string; workerId?: string; isManager: boolean };
  manager?: { target: string; connected: boolean };
  coworkers: TeamMember[];
}

const LEGACY_LIVE_STATES = new Set(["provisioning", "running", "idle", "needs_attention", "stopping"]);
const BOSS_NONTERMINAL_STATES: ReadonlySet<string> = new Set(
  PARTICIPANT_STATES.filter((state) => !(TERMINAL_PARTICIPANT_STATES as readonly string[]).includes(state)),
);

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function exactStringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function positiveIntegerString(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function connectedTo(sessions: TeamSession[], target: string): boolean {
  const normalized = target.toLowerCase();
  return sessions.some((session) => session.id === target || session.name?.toLowerCase() === normalized);
}

async function readWorkers(agentDir: string): Promise<StoredWorker[]> {
  try {
    const parsed = JSON.parse(await readFile(join(agentDir, "intercom", "orchestrator", "workers.json"), "utf8")) as { workers?: unknown };
    return Array.isArray(parsed.workers) ? parsed.workers as StoredWorker[] : [];
  } catch {
    return [];
  }
}

function bossSessionHasExactAuthority(session: TeamSession): boolean {
  const binding = session.boss?.binding;
  const principal = session.boss?.principal;
  const liveWorker = session.boss?.liveWorker;
  const liveIdentity = liveWorker?.identity;
  return binding !== undefined
    && principal !== undefined
    && liveWorker !== undefined
    && liveIdentity !== undefined
    && binding.sessionId === session.id
    && binding.state === "active"
    && principal.principalClass === "boss-private"
    && principal.principalId === session.id
    && principal.state === "active"
    && principal.bossRunId === binding.bossRunId
    && principal.participantId === binding.participantId
    && principal.role === binding.role
    && principal.bindingEpoch === binding.bindingEpoch
    && principal.assignedManagerParticipantId === binding.assignedManagerParticipantId
    && ((binding.role === "worker" || binding.role === "scout") === (binding.assignedManagerParticipantId !== undefined))
    && ((principal.role === "manager") === Array.isArray(principal.assignedParticipantIds))
    && (principal.role === "manager" || principal.assignedParticipantIds === undefined)
    && liveIdentity.workerId === session.id
    && "bossRunId" in liveIdentity
    && liveIdentity.bossRunId === binding.bossRunId
    && liveIdentity.participantId === binding.participantId
    && liveIdentity.bindingEpoch === binding.bindingEpoch
    && BOSS_NONTERMINAL_STATES.has(liveWorker.state);
}

function bossWorkerMatchesSession(worker: StoredWorker, session: TeamSession): boolean {
  const binding = session.boss?.binding;
  const liveWorker = session.boss?.liveWorker;
  const liveIdentity = liveWorker?.identity;
  const id = exactStringValue(worker.id);
  const target = exactStringValue(worker.intercomTarget);
  const storedSessionId = exactStringValue(worker.sessionId) ?? target;
  return bossSessionHasExactAuthority(session)
    && binding !== undefined
    && liveWorker !== undefined
    && liveIdentity !== undefined
    && worker.owned === true
    && id !== undefined
    && target === id
    && storedSessionId === id
    && session.id === id
    && binding.sessionId === session.id
    && binding.state === "active"
    && BOSS_NONTERMINAL_STATES.has(liveWorker.state)
    && exactStringValue(worker.state) === liveWorker.state
    && exactStringValue(worker.bossRunId) === binding.bossRunId
    && exactStringValue(worker.participantId) === binding.participantId
    && positiveInteger(worker.bindingEpoch) === binding.bindingEpoch
    && exactStringValue(worker.role) === binding.role
    && liveIdentity.workerId === id
    && liveIdentity.workerId === session.id
    && liveIdentity.workerIncarnationId === exactStringValue(worker.workerIncarnationId)
    && liveIdentity.workerGeneration === positiveInteger(worker.workerGeneration)
    && liveIdentity.bossRunId === binding.bossRunId
    && liveIdentity.participantId === binding.participantId
    && liveIdentity.bindingEpoch === binding.bindingEpoch;
}

function isReciprocallyAssignedToManager(workerSession: TeamSession, managerSession: TeamSession): boolean {
  const workerBinding = workerSession.boss?.binding;
  const workerPrincipal = workerSession.boss?.principal;
  const managerBinding = managerSession.boss?.binding;
  const managerPrincipal = managerSession.boss?.principal;
  return bossSessionHasExactAuthority(workerSession)
    && bossSessionHasExactAuthority(managerSession)
    && (workerBinding?.role === "worker" || workerBinding?.role === "scout")
    && workerPrincipal?.role === workerBinding.role
    && managerBinding?.role === "manager"
    && managerPrincipal?.role === "manager"
    && workerBinding.bossRunId === managerBinding.bossRunId
    && workerBinding.assignedManagerParticipantId === managerBinding.participantId
    && workerPrincipal.assignedManagerParticipantId === managerPrincipal.participantId
    && managerPrincipal.assignedParticipantIds?.includes(workerBinding.participantId) === true;
}

function currentBossWorker(
  workers: StoredWorker[],
  self: TeamSession,
  env: NodeJS.ProcessEnv,
): StoredWorker | undefined {
  const binding = self.boss?.binding;
  const liveIdentity = self.boss?.liveWorker.identity;
  if (!binding) return undefined;
  const workerId = exactStringValue(env.AGENT_INTERCOM_WORKER_ID);
  const incarnationId = exactStringValue(env.AGENT_INTERCOM_WORKER_INCARNATION_ID);
  const deprecatedIncarnationId = exactStringValue(env.AGENT_INTERCOM_RUN_ID);
  const workerGeneration = positiveIntegerString(env.AGENT_INTERCOM_WORKER_GENERATION);
  const bindingEpoch = positiveIntegerString(env.AGENT_INTERCOM_BINDING_EPOCH);
  if (
    workerId === undefined
    || incarnationId === undefined
    || (deprecatedIncarnationId !== undefined && deprecatedIncarnationId !== incarnationId)
    || workerGeneration === undefined
    || bindingEpoch === undefined
    || liveIdentity === undefined
    || liveIdentity.workerId !== workerId
    || liveIdentity.workerIncarnationId !== incarnationId
    || liveIdentity.workerGeneration !== workerGeneration
    || liveIdentity.bossRunId !== binding.bossRunId
    || liveIdentity.participantId !== binding.participantId
    || liveIdentity.bindingEpoch !== binding.bindingEpoch
    || exactStringValue(env.AGENT_INTERCOM_BOSS_RUN_ID) !== binding.bossRunId
    || exactStringValue(env.AGENT_INTERCOM_PARTICIPANT_ID) !== binding.participantId
    || bindingEpoch !== binding.bindingEpoch
  ) return undefined;

  return workers.find((worker) =>
    exactStringValue(worker.id) === workerId
    && exactStringValue(worker.workerIncarnationId) === incarnationId
    && positiveInteger(worker.workerGeneration) === workerGeneration
    && bossWorkerMatchesSession(worker, self)
  );
}

function teamMember(worker: StoredWorker, session: TeamSession): TeamMember {
  const id = stringValue(worker.id)!;
  return {
    id,
    target: id,
    ...(stringValue(worker.harness) ? { harness: stringValue(worker.harness) } : {}),
    ...(stringValue(worker.role) ? { role: stringValue(worker.role) } : {}),
    ...(stringValue(worker.state) ? { state: stringValue(worker.state) } : {}),
    connected: session.id === id,
  };
}

function resolveLegacyTeam(
  input: { selfId: string; sessions: TeamSession[] },
  workers: StoredWorker[],
  env: NodeJS.ProcessEnv,
): IntercomTeam {
  const workerId = stringValue(env.AGENT_INTERCOM_WORKER_ID);
  const runId = stringValue(env.AGENT_INTERCOM_RUN_ID);
  const current = workerId
    ? workers.find((worker) =>
      stringValue(worker.id) === workerId
      && (!runId || stringValue(worker.runId) === runId)
    )
    : undefined;
  const managerTarget = stringValue(current?.managerSessionId)
    ?? stringValue(env.AGENT_INTERCOM_MANAGER_TARGET)
    ?? stringValue(env.AGENT_INTERCOM_MANAGER_SESSION_ID);
  const teamId = managerTarget ?? input.selfId;
  const coworkers = workers
    .filter((worker) => worker.owned === true)
    .filter((worker) => stringValue(worker.managerSessionId) === teamId)
    .filter((worker) => LEGACY_LIVE_STATES.has(stringValue(worker.state) ?? ""))
    .filter((worker) => stringValue(worker.id) !== workerId)
    .map((worker): TeamMember | undefined => {
      const id = stringValue(worker.id);
      if (!id) return undefined;
      const target = stringValue(worker.intercomTarget) ?? id;
      return {
        id,
        target,
        ...(stringValue(worker.harness) ? { harness: stringValue(worker.harness) } : {}),
        ...(stringValue(worker.role) ? { role: stringValue(worker.role) } : {}),
        ...(stringValue(worker.state) ? { state: stringValue(worker.state) } : {}),
        connected: connectedTo(input.sessions, target),
      };
    })
    .filter((member): member is TeamMember => Boolean(member));
  return {
    teamId,
    self: { id: input.selfId, ...(workerId ? { workerId } : {}), isManager: !managerTarget },
    manager: managerTarget
      ? { target: managerTarget, connected: connectedTo(input.sessions, managerTarget) }
      : { target: input.selfId, connected: true },
    coworkers,
  };
}

export async function resolveIntercomTeam(input: {
  selfId: string;
  sessions: TeamSession[];
  env?: NodeJS.ProcessEnv;
  agentDir?: string;
}): Promise<IntercomTeam> {
  const env = input.env ?? process.env;
  const workers = await readWorkers(input.agentDir ?? getAgentDirPath());
  const selfSession = input.sessions.find((session) => session.id === input.selfId);
  if (!selfSession?.boss) return resolveLegacyTeam(input, workers, env);

  const current = currentBossWorker(workers, selfSession, env);
  const workerId = stringValue(env.AGENT_INTERCOM_WORKER_ID);
  if (!current) {
    return {
      teamId: selfSession.boss.binding.bossRunId,
      self: { id: input.selfId, ...(workerId ? { workerId } : {}), isManager: false },
      coworkers: [],
    };
  }

  const currentRole = selfSession.boss.binding.role;
  const selfIsManager = currentRole === "manager";
  const configuredManagerTarget = selfIsManager ? input.selfId : exactStringValue(current.managerSessionId);
  const managerSession = configuredManagerTarget === undefined
    ? undefined
    : input.sessions.find((session) => session.id === configuredManagerTarget);
  const managerWorker = managerSession === undefined
    ? undefined
    : workers.find((worker) => exactStringValue(worker.id) === configuredManagerTarget && bossWorkerMatchesSession(worker, managerSession));
  const managerTarget = selfIsManager
    ? input.selfId
    : managerWorker !== undefined
      && managerSession?.boss?.binding.bossRunId === selfSession.boss.binding.bossRunId
      && isReciprocallyAssignedToManager(selfSession, managerSession)
      ? configuredManagerTarget
      : undefined;

  if (managerTarget === undefined) {
    return {
      teamId: selfSession.boss.binding.bossRunId,
      self: { id: input.selfId, ...(workerId ? { workerId } : {}), isManager: false },
      coworkers: [],
    };
  }

  const coworkers = workers
    .filter((worker) => exactStringValue(worker.id) !== workerId)
    .filter((worker) => exactStringValue(worker.managerSessionId) === managerTarget)
    .map((worker): TeamMember | undefined => {
      const id = exactStringValue(worker.id);
      if (!id) return undefined;
      const session = input.sessions.find((candidate) => candidate.id === id);
      if (
        session === undefined
        || !bossWorkerMatchesSession(worker, session)
        || session.boss?.binding.bossRunId !== selfSession.boss!.binding.bossRunId
        || managerSession === undefined
        || !isReciprocallyAssignedToManager(session, managerSession)
      ) return undefined;
      return teamMember(worker, session);
    })
    .filter((member): member is TeamMember => Boolean(member));

  return {
    teamId: selfSession.boss.binding.bossRunId,
    self: { id: input.selfId, ...(workerId ? { workerId } : {}), isManager: selfIsManager },
    manager: { target: managerTarget, connected: true },
    coworkers,
  };
}

export function formatIntercomTeam(team: IntercomTeam): string {
  const lines = [
    `Manager: ${team.manager ? `${team.manager.target} [${team.manager.connected ? "connected" : "not connected"}]` : "unknown"}`,
    `You: ${team.self.id}${team.self.isManager ? " [manager]" : ""}`,
  ];
  if (!team.coworkers.length) {
    lines.push("Coworkers: none");
  } else {
    lines.push("Coworkers:");
    for (const coworker of team.coworkers) {
      const metadata = [coworker.harness, coworker.role, coworker.state].filter(Boolean).join(", ");
      lines.push(`- ${coworker.id} target=${coworker.target}${metadata ? ` (${metadata})` : ""} [${coworker.connected ? "connected" : "not connected"}]`);
    }
  }
  return lines.join("\n");
}
