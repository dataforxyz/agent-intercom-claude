import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  BOSS_PARTICIPANT_BINDING_VERSION,
  BOSS_POLICY_PRINCIPAL_VERSION,
  WORKER_IDENTITY_VERSION,
  type BossParticipantRole,
  type BossPrivatePrincipal,
} from "@dataforxyz/agent-intercom-core/boss";
import { brokerGeneration, participantBindingEpoch, workerGeneration } from "@dataforxyz/agent-intercom-core/canonical";
import { resolveIntercomTeam, type TeamSession } from "./team.ts";

const legacyWorker = (id: string, runId: string, managerSessionId: string, state = "running") => ({
  id,
  runId,
  harness: "claude",
  role: "reviewer",
  state,
  owned: true,
  managerSessionId,
  intercomTarget: id,
});

function bossWorker(
  id: string,
  role: BossParticipantRole,
  managerSessionId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    workerIncarnationId: `inc-${id}`,
    workerGeneration: 2,
    bossRunId: "boss-run-a",
    participantId: `participant-${id}`,
    bindingEpoch: 3,
    sessionId: id,
    harness: "claude",
    role,
    state: "working",
    owned: true,
    managerSessionId,
    intercomTarget: id,
    ...overrides,
  };
}

type BossBindingOverrides = Partial<NonNullable<TeamSession["boss"]>["binding"]>;
type BossPrincipalOverrides = Partial<BossPrivatePrincipal>;
type BossLiveWorkerOverrides = {
  identity?: Partial<NonNullable<TeamSession["boss"]>["liveWorker"]["identity"]>;
  state?: NonNullable<TeamSession["boss"]>["liveWorker"]["state"];
};

function bossSession(
  id: string,
  role: BossParticipantRole,
  overrides: BossBindingOverrides = {},
  liveOverrides: BossLiveWorkerOverrides = {},
  principalOverrides: BossPrincipalOverrides = {},
): TeamSession {
  const bindingEpoch = participantBindingEpoch(3);
  const assignedManagerParticipantId = "participant-manager";
  return {
    id,
    boss: {
      binding: {
        version: BOSS_PARTICIPANT_BINDING_VERSION,
        bossRunId: "boss-run-a",
        participantId: `participant-${id}`,
        bindingEpoch,
        role,
        communicationProfile: role,
        sessionId: id,
        brokerGeneration: brokerGeneration(1),
        brokerBootInstance: "boot-a",
        state: "active",
        ...(role === "worker" || role === "scout" ? { assignedManagerParticipantId } : {}),
        authorityTransitionId: `transition-${id}`,
        ...overrides,
      },
      principal: {
        version: BOSS_POLICY_PRINCIPAL_VERSION,
        principalId: id,
        principalClass: "boss-private",
        state: "active",
        bossRunId: "boss-run-a",
        participantId: `participant-${id}`,
        role,
        bindingEpoch,
        ...(role === "worker" || role === "scout" ? { assignedManagerParticipantId } : {}),
        ...(role === "manager" ? { assignedParticipantIds: ["participant-self", "participant-peer"] } : {}),
        ...(role === "council" ? { requestingPrincipalId: "boss" } : {}),
        ...principalOverrides,
      },
      liveWorker: {
        identity: {
          version: WORKER_IDENTITY_VERSION,
          workerId: id,
          workerIncarnationId: `inc-${id}`,
          workerGeneration: workerGeneration(2),
          bossRunId: "boss-run-a",
          participantId: `participant-${id}`,
          bindingEpoch,
          ...liveOverrides.identity,
        },
        state: liveOverrides.state ?? "working",
      },
    },
  };
}

async function withWorkers(
  workers: unknown[],
  run: (agentDir: string) => Promise<void>,
): Promise<void> {
  const agentDir = await mkdtemp(join(tmpdir(), "claude-team-"));
  const dir = join(agentDir, "intercom", "orchestrator");
  await mkdir(dir, { recursive: true });
  try {
    await writeFile(join(dir, "workers.json"), JSON.stringify({ version: 2, workers }));
    await run(agentDir);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
}

function bossEnvironment(id: string): NodeJS.ProcessEnv {
  return {
    AGENT_INTERCOM_WORKER_ID: id,
    AGENT_INTERCOM_WORKER_INCARNATION_ID: `inc-${id}`,
    AGENT_INTERCOM_WORKER_GENERATION: "2",
    AGENT_INTERCOM_BOSS_RUN_ID: "boss-run-a",
    AGENT_INTERCOM_PARTICIPANT_ID: `participant-${id}`,
    AGENT_INTERCOM_BINDING_EPOCH: "3",
  };
}

const bossEnv = bossEnvironment("self");

test("ordinary team discovery preserves the legacy orchestrator-owner projection", async () => {
  await withWorkers([
    legacyWorker("self", "run-self", "manager-new"),
    legacyWorker("peer", "run-peer", "manager-new"),
    legacyWorker("old", "run-old", "manager-old"),
  ], async (agentDir) => {
    const team = await resolveIntercomTeam({
      selfId: "self",
      agentDir,
      env: {
        AGENT_INTERCOM_WORKER_ID: "self",
        AGENT_INTERCOM_WORKER_INCARNATION_ID: "ignored-by-ordinary-discovery",
        AGENT_INTERCOM_RUN_ID: "run-self",
        AGENT_INTERCOM_MANAGER_SESSION_ID: "manager-old",
      },
      sessions: [{ id: "manager-new" }, { id: "peer" }],
    });
    assert.equal(team.manager?.target, "manager-new");
    assert.equal(team.manager?.connected, true);
    assert.deepEqual(team.coworkers.map((entry) => entry.id), ["peer"]);
  });
});

test("Boss team discovery intersects every registry identity field with exact live sessions", async () => {
  await withWorkers([
    bossWorker("self", "worker", "manager"),
    bossWorker("manager", "manager", "boss"),
    bossWorker("peer", "worker", "manager"),
  ], async (agentDir) => {
    const team = await resolveIntercomTeam({
      selfId: "self",
      agentDir,
      env: bossEnv,
      sessions: [bossSession("self", "worker"), bossSession("manager", "manager"), bossSession("peer", "worker")],
    });
    assert.equal(team.teamId, "boss-run-a");
    assert.equal(team.manager?.target, "manager");
    assert.equal(team.self.isManager, false);
    assert.deepEqual(team.coworkers.map((entry) => entry.id), ["peer"]);
  });
});

test("Boss worker discovery requires the registry edge and reciprocal Core assignment authority", async () => {
  const cases: Array<{
    name: string;
    current: Record<string, unknown>;
    currentSession: TeamSession;
    managerId: string;
    managerSession: TeamSession;
    otherWorkers?: Record<string, unknown>[];
    otherSessions?: TeamSession[];
  }> = [
    {
      name: "alternate same-run Manager",
      current: bossWorker("self", "worker", "manager-alt"),
      currentSession: bossSession("self", "worker"),
      managerId: "manager-alt",
      managerSession: bossSession("manager-alt", "manager", {}, {}, { assignedParticipantIds: ["participant-self"] }),
      otherWorkers: [bossWorker("manager", "manager", "boss")],
      otherSessions: [bossSession("manager", "manager")],
    },
    {
      name: "binding points to another Manager participant",
      current: bossWorker("self", "worker", "manager"),
      currentSession: bossSession(
        "self",
        "worker",
        { assignedManagerParticipantId: "participant-manager-alt" },
        {},
        { assignedManagerParticipantId: "participant-manager-alt" },
      ),
      managerId: "manager",
      managerSession: bossSession("manager", "manager"),
    },
    {
      name: "Manager principal does not assign the Worker",
      current: bossWorker("self", "worker", "manager"),
      currentSession: bossSession("self", "worker"),
      managerId: "manager",
      managerSession: bossSession("manager", "manager", {}, {}, { assignedParticipantIds: ["participant-peer"] }),
    },
    {
      name: "unassigned Worker",
      current: bossWorker("self", "worker", "manager"),
      currentSession: bossSession(
        "self",
        "worker",
        { assignedManagerParticipantId: undefined },
        {},
        { assignedManagerParticipantId: undefined },
      ),
      managerId: "manager",
      managerSession: bossSession("manager", "manager"),
    },
    {
      name: "non-managed Boss role",
      current: bossWorker("self", "adversary", "manager"),
      currentSession: bossSession("self", "adversary"),
      managerId: "manager",
      managerSession: bossSession("manager", "manager"),
    },
  ];

  for (const fixture of cases) {
    await withWorkers([
      fixture.current,
      bossWorker(fixture.managerId, "manager", "boss"),
      ...(fixture.otherWorkers ?? []),
    ], async (agentDir) => {
      const team = await resolveIntercomTeam({
        selfId: "self",
        agentDir,
        env: bossEnv,
        sessions: [fixture.currentSession, fixture.managerSession, ...(fixture.otherSessions ?? [])],
      });
      assert.equal(team.manager, undefined, fixture.name);
      assert.equal(team.self.isManager, false, fixture.name);
      assert.deepEqual(team.coworkers, [], fixture.name);
    });
  }
});

test("Boss Manager discovery exposes only reciprocally assigned live Workers", async () => {
  await withWorkers([
    bossWorker("manager", "manager", "boss"),
    bossWorker("peer", "worker", "manager"),
    bossWorker("unassigned", "worker", "manager"),
  ], async (agentDir) => {
    const team = await resolveIntercomTeam({
      selfId: "manager",
      agentDir,
      env: bossEnvironment("manager"),
      sessions: [
        bossSession("manager", "manager", {}, {}, { assignedParticipantIds: ["participant-peer"] }),
        bossSession("peer", "worker"),
        bossSession("unassigned", "worker"),
      ],
    });
    assert.equal(team.manager?.target, "manager");
    assert.equal(team.self.isManager, true);
    assert.deepEqual(team.coworkers.map((entry) => entry.id), ["peer"]);
  });
});

test("Boss coworker discovery intersects each registry edge with both assignment directions", async () => {
  const cases = [
    {
      name: "Worker binding points to another Manager participant",
      peerSession: bossSession(
        "peer",
        "worker",
        { assignedManagerParticipantId: "participant-manager-alt" },
        {},
        { assignedManagerParticipantId: "participant-manager-alt" },
      ),
      managerSession: bossSession("manager", "manager"),
    },
    {
      name: "Manager principal omits Worker participant",
      peerSession: bossSession("peer", "worker"),
      managerSession: bossSession("manager", "manager", {}, {}, { assignedParticipantIds: ["participant-self"] }),
    },
    {
      name: "registry-owned but non-managed Boss role",
      peerSession: bossSession("peer", "adversary"),
      managerSession: bossSession("manager", "manager"),
    },
  ];

  for (const fixture of cases) {
    await withWorkers([
      bossWorker("self", "worker", "manager"),
      bossWorker("manager", "manager", "boss"),
      bossWorker("peer", fixture.peerSession.boss!.binding.role, "manager"),
    ], async (agentDir) => {
      const team = await resolveIntercomTeam({
        selfId: "self",
        agentDir,
        env: bossEnv,
        sessions: [bossSession("self", "worker"), fixture.managerSession, fixture.peerSession],
      });
      assert.equal(team.manager?.target, "manager", fixture.name);
      assert.deepEqual(team.coworkers, [], fixture.name);
    });
  }
});

test("Boss team discovery denies target substitution, name collision, and stale Manager promotion", async () => {
  await withWorkers([
    bossWorker("self", "worker", "manager"),
    bossWorker("manager", "manager", "boss"),
    bossWorker("peer", "worker", "manager", { intercomTarget: "manager" }),
  ], async (agentDir) => {
    const team = await resolveIntercomTeam({
      selfId: "self",
      agentDir,
      env: bossEnv,
      sessions: [
        bossSession("self", "worker"),
        { ...bossSession("unrelated", "manager"), name: "manager" },
        bossSession("peer", "worker"),
      ],
    });
    assert.equal(team.manager, undefined);
    assert.equal(team.self.isManager, false);
    assert.deepEqual(team.coworkers, []);
  });
  await withWorkers([
    bossWorker("self", "worker", "manager"),
    bossWorker("manager", "worker", "boss"),
  ], async (agentDir) => {
    const team = await resolveIntercomTeam({
      selfId: "self",
      agentDir,
      env: bossEnv,
      sessions: [bossSession("self", "worker"), bossSession("manager", "worker")],
    });
    assert.equal(team.manager, undefined);
    assert.equal(team.self.isManager, false);
  });
});

test("Boss current identity fails closed on run, participant, epoch, role, session, incarnation, generation, or state mismatch", async () => {
  const cases: Array<{ name: string; worker?: Record<string, unknown>; session?: TeamSession; env?: NodeJS.ProcessEnv }> = [
    { name: "run", worker: bossWorker("self", "worker", "manager", { bossRunId: "boss-run-b" }) },
    { name: "participant", worker: bossWorker("self", "worker", "manager", { participantId: "other" }) },
    { name: "epoch", worker: bossWorker("self", "worker", "manager", { bindingEpoch: 4 }) },
    { name: "role", worker: bossWorker("self", "scout", "manager") },
    { name: "session", worker: bossWorker("self", "worker", "manager", { sessionId: "other" }) },
    { name: "incarnation", worker: bossWorker("self", "worker", "manager", { workerIncarnationId: "stale" }) },
    { name: "generation", worker: bossWorker("self", "worker", "manager", { workerGeneration: 1 }) },
    { name: "state", worker: bossWorker("self", "worker", "manager", { state: "stopped" }) },
    { name: "missing canonical incarnation", worker: bossWorker("self", "worker", "manager", { workerIncarnationId: undefined, runId: "inc-self" }) },
    { name: "binding session", session: bossSession("self", "worker", { sessionId: "other" }) },
    { name: "principal session", session: bossSession("self", "worker", {}, {}, { principalId: "other" }) },
    { name: "principal run", session: bossSession("self", "worker", {}, {}, { bossRunId: "boss-run-b" }) },
    { name: "principal participant", session: bossSession("self", "worker", {}, {}, { participantId: "other" }) },
    { name: "principal epoch", session: bossSession("self", "worker", {}, {}, { bindingEpoch: participantBindingEpoch(4) }) },
    { name: "principal role", session: bossSession("self", "worker", {}, {}, { role: "scout" }) },
    { name: "principal state", session: bossSession("self", "worker", {}, {}, { state: "revoked" }) },
    { name: "binding assignment", session: bossSession("self", "worker", { assignedManagerParticipantId: "participant-manager-alt" }) },
    { name: "live run", session: bossSession("self", "worker", {}, { identity: { bossRunId: "boss-run-b" } }) },
    { name: "live participant", session: bossSession("self", "worker", {}, { identity: { participantId: "other" } }) },
    { name: "live epoch", session: bossSession("self", "worker", {}, { identity: { bindingEpoch: participantBindingEpoch(4) } }) },
    { name: "live state", session: bossSession("self", "worker", {}, { state: "waiting" }) },
    { name: "terminal live state", session: bossSession("self", "worker", {}, { state: "stopped" }) },
    { name: "environment epoch", env: { ...bossEnv, AGENT_INTERCOM_BINDING_EPOCH: "0" } },
    { name: "deprecated environment mismatch", env: { ...bossEnv, AGENT_INTERCOM_RUN_ID: "stale-self" } },
    { name: "deprecated-only environment", env: { ...bossEnv, AGENT_INTERCOM_WORKER_INCARNATION_ID: undefined, AGENT_INTERCOM_RUN_ID: "inc-self" } },
  ];
  for (const mismatch of cases) {
    await withWorkers([
      mismatch.worker ?? bossWorker("self", "worker", "manager"),
      bossWorker("manager", "manager", "boss"),
    ], async (agentDir) => {
      const team = await resolveIntercomTeam({
        selfId: "self",
        agentDir,
        env: mismatch.env ?? bossEnv,
        sessions: [mismatch.session ?? bossSession("self", "worker"), bossSession("manager", "manager")],
      });
      assert.equal(team.manager, undefined, mismatch.name);
      assert.equal(team.self.isManager, false, mismatch.name);
      assert.deepEqual(team.coworkers, [], mismatch.name);
    });
  }
});

test("Boss Manager projection rejects stale registry incarnation, generation, and canonical state against live authority", async () => {
  for (const mismatch of [
    { name: "incarnation", override: { workerIncarnationId: "stale-manager" } },
    { name: "generation", override: { workerGeneration: 1 } },
    { name: "state", override: { state: "waiting" } },
  ]) {
    await withWorkers([
      bossWorker("self", "worker", "manager"),
      bossWorker("manager", "manager", "boss", mismatch.override),
    ], async (agentDir) => {
      const team = await resolveIntercomTeam({
        selfId: "self",
        agentDir,
        env: bossEnv,
        sessions: [bossSession("self", "worker"), bossSession("manager", "manager")],
      });
      assert.equal(team.manager, undefined, mismatch.name);
      assert.deepEqual(team.coworkers, [], mismatch.name);
    });
  }
});

test("Boss coworker projection rejects stale registry incarnation, generation, and canonical state against live authority", async () => {
  for (const mismatch of [
    { name: "incarnation", override: { workerIncarnationId: "stale-peer" } },
    { name: "generation", override: { workerGeneration: 1 } },
    { name: "state", override: { state: "waiting" } },
  ]) {
    await withWorkers([
      bossWorker("self", "worker", "manager"),
      bossWorker("manager", "manager", "boss"),
      bossWorker("peer", "worker", "manager", mismatch.override),
    ], async (agentDir) => {
      const team = await resolveIntercomTeam({
        selfId: "self",
        agentDir,
        env: bossEnv,
        sessions: [bossSession("self", "worker"), bossSession("manager", "manager"), bossSession("peer", "worker")],
      });
      assert.equal(team.manager?.target, "manager", mismatch.name);
      assert.deepEqual(team.coworkers, [], mismatch.name);
    });
  }
});

test("Boss Manager and coworker projections reject substituted live authority values independently", async () => {
  for (const target of ["manager", "peer"] as const) {
    await withWorkers([
      bossWorker("self", "worker", "manager"),
      bossWorker("manager", "manager", "boss"),
      bossWorker("peer", "worker", "manager"),
    ], async (agentDir) => {
      const sessions = [
        bossSession("self", "worker"),
        bossSession("manager", "manager", {}, target === "manager"
          ? { identity: { workerIncarnationId: "substituted-live-manager" } }
          : {}),
        bossSession("peer", "worker", {}, target === "peer"
          ? { identity: { workerGeneration: workerGeneration(3) } }
          : {}),
      ];
      const team = await resolveIntercomTeam({ selfId: "self", agentDir, env: bossEnv, sessions });
      if (target === "manager") {
        assert.equal(team.manager, undefined);
        assert.deepEqual(team.coworkers, []);
      } else {
        assert.equal(team.manager?.target, "manager");
        assert.deepEqual(team.coworkers, []);
      }
    });
  }
});
