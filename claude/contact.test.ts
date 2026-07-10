import assert from "node:assert/strict";
import test from "node:test";
import { formatContactInstruction } from "./contact.ts";
import type { SessionInfo } from "../types.ts";

const session = (id: string, name: string): SessionInfo => ({ id, name, cwd: "/tmp", model: "claude", pid: 1, startedAt: 1, lastActivity: 1 });

test("contact instructions prefer a unique name and retain the stable id", () => {
  assert.equal(formatContactInstruction(session("abc", "worker"), [session("abc", "worker")]), "Intercom target: worker\nStable session ID: abc");
});

test("contact instructions use the id when names are duplicated", () => {
  assert.equal(formatContactInstruction(session("abc", "worker"), [session("abc", "worker"), session("def", "worker")]), "Intercom target: abc");
});
