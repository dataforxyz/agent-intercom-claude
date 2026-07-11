import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { buildTuiAppendSystemPrompt, createDefaultIdentity, parseCciArgs, resolveIntercomSelection, sanitizeSegment } from "./cci.ts";

test("sanitizeSegment keeps readable safe ids", () => {
  assert.equal(sanitizeSegment("Claude:Repo Main#123"), "claude:repo-main-123");
  assert.equal(sanitizeSegment(""), "claude");
});

test("resolveIntercomSelection accepts only an in-range numbered choice", () => {
  assert.equal(resolveIntercomSelection(" 2 ", 3), 1);
  assert.equal(resolveIntercomSelection("0", 3), null);
  assert.equal(resolveIntercomSelection("4", 3), null);
  assert.equal(resolveIntercomSelection("worker", 3), null);
});

test("createDefaultIdentity derives readable per-process defaults", () => {
  const identity = createDefaultIdentity({
    cwd: "/home/me/src/project",
    pid: 4321,
    gitRoot: "/home/me/src/project",
    branch: "main",
  });
  assert.match(identity.id, /^claude-project-main-[a-f0-9]{8}-4321$/);
  assert.equal(identity.name, "claude:project:main#4321");
});

test("parseCciArgs reads name, id, cwd, instructions, and model", () => {
  const parsed = parseCciArgs([
    "--name", "worker",
    "--id=worker-1",
    "--cwd", "/tmp/project",
    "--instructions", "Stay terse.",
    "--model=opus",
  ], {});

  assert.equal(parsed.name, "worker");
  assert.equal(parsed.id, "worker-1");
  assert.equal(parsed.cwd, "/tmp/project");
  assert.equal(parsed.instructions, "Stay terse.");
  assert.equal(parsed.model, "opus");
});

test("parseCciArgs tui defaults to false and is enabled by --tui/--live", () => {
  assert.equal(parseCciArgs([], {}).tui, false);
  assert.equal(parseCciArgs(["--tui"], {}).tui, true);
  assert.equal(parseCciArgs(["--live"], {}).tui, true);
});

test("buildTuiAppendSystemPrompt names the identity and the reply protocol", () => {
  const prompt = buildTuiAppendSystemPrompt("reviewer", "claude-reviewer-1");
  assert.match(prompt, /reviewer/);
  assert.match(prompt, /claude-reviewer-1/);
  assert.match(prompt, /intercom_reply/);
  assert.match(prompt, /awaiting your reply/);
});

test("parseCciArgs defaults to dangerouslySkipPermissions=true when neither --yolo nor --safe is given", () => {
  const parsed = parseCciArgs([], {});
  assert.equal(parsed.dangerouslySkipPermissions, true);
  assert.equal(parsed.permissionMode, undefined);
});

test("parseCciArgs --yolo is explicit and equivalent to the default posture", () => {
  const parsed = parseCciArgs(["--yolo"], {});
  assert.equal(parsed.dangerouslySkipPermissions, true);
});

test("parseCciArgs minimal defaults to false and is enabled by --minimal/--bare", () => {
  assert.equal(parseCciArgs([], {}).minimal, false);
  assert.equal(parseCciArgs(["--minimal"], {}).minimal, true);
  assert.equal(parseCciArgs(["--bare"], {}).minimal, true);
});

test("parseCciArgs --dangerously-skip-permissions behaves like --yolo", () => {
  const parsed = parseCciArgs(["--dangerously-skip-permissions"], {});
  assert.equal(parsed.dangerouslySkipPermissions, true);
});

test("parseCciArgs --safe opts out of the yolo default and sets permission-mode default", () => {
  const parsed = parseCciArgs(["--safe"], {});
  assert.equal(parsed.dangerouslySkipPermissions, false);
  assert.equal(parsed.permissionMode, "default");
});

test("parseCciArgs --safe respects an explicit --permission-mode", () => {
  const parsed = parseCciArgs(["--permission-mode", "plan", "--safe"], {});
  assert.equal(parsed.dangerouslySkipPermissions, false);
  assert.equal(parsed.permissionMode, "plan");
});

test("parseCciArgs last of --yolo/--safe wins when both are given", () => {
  const safeThenYolo = parseCciArgs(["--safe", "--yolo"], {});
  assert.equal(safeThenYolo.dangerouslySkipPermissions, true);

  const yoloThenSafe = parseCciArgs(["--yolo", "--safe"], {});
  assert.equal(yoloThenSafe.dangerouslySkipPermissions, false);
});

test("parseCciArgs collects repeatable --add-dir flags", () => {
  const parsed = parseCciArgs(["--add-dir", "/a", "--add-dir=/b"], {});
  assert.deepEqual(parsed.addDirs, [resolve("/a"), resolve("/b")]);
});

test("parseCciArgs falls back to env vars, then defaults", () => {
  const parsed = parseCciArgs([], {
    CLAUDE_INTERCOM_NAME: "env-name",
    CLAUDE_INTERCOM_SESSION_ID: "env-id",
    CLAUDE_INTERCOM_CLAUDE_COMMAND: "claude-custom",
  });
  assert.equal(parsed.name, "env-name");
  assert.equal(parsed.id, "env-id");
  assert.equal(parsed.claudeCommand, "claude-custom");
});

test("parseCciArgs defaults claudeCommand to \"claude\"", () => {
  const parsed = parseCciArgs([], {});
  assert.equal(parsed.claudeCommand, "claude");
});
