import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveIntercomTeam } from "./team.ts";
const worker = (id: string, runId: string, managerSessionId: string, state = "running") => ({ id, runId, harness: "claude", role: "reviewer", state, owned: true, managerSessionId, intercomTarget: id });
test("team discovery follows the orchestrator owner instead of stale worker environment", async () => { const agentDir = await mkdtemp(join(tmpdir(), "claude-team-")); const dir = join(agentDir, "intercom", "orchestrator"); await mkdir(dir, { recursive: true }); try { await writeFile(join(dir, "workers.json"), JSON.stringify({ version: 1, workers: [worker("self", "run-self", "manager-new"), worker("peer", "run-peer", "manager-new"), worker("old", "run-old", "manager-old")] })); const team = await resolveIntercomTeam({ selfId: "self", agentDir, env: { AGENT_INTERCOM_WORKER_ID: "self", AGENT_INTERCOM_RUN_ID: "run-self", AGENT_INTERCOM_MANAGER_SESSION_ID: "manager-old" }, sessions: [{ id: "manager-new" }, { id: "peer" }] }); assert.equal(team.manager?.target, "manager-new"); assert.equal(team.manager?.connected, true); assert.deepEqual(team.coworkers.map((entry) => entry.id), ["peer"]); } finally { await rm(agentDir, { recursive: true, force: true }); } });
