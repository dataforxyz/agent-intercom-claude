import test from "node:test";
import assert from "node:assert/strict";
import { buildClaudeArgs } from "./cli-runner.ts";

test("buildClaudeArgs has the base -p --output-format json flags", () => {
  const args = buildClaudeArgs({ prompt: "hello", cwd: "/tmp" });
  assert.deepEqual(args.slice(0, 3), ["-p", "--output-format", "json"]);
});

test("buildClaudeArgs adds --resume when sessionId is set", () => {
  const args = buildClaudeArgs({ prompt: "hello", cwd: "/tmp", sessionId: "abc-123" });
  assert.ok(args.includes("--resume"));
  assert.equal(args[args.indexOf("--resume") + 1], "abc-123");
});

test("buildClaudeArgs omits --resume when no sessionId is set", () => {
  const args = buildClaudeArgs({ prompt: "hello", cwd: "/tmp" });
  assert.equal(args.includes("--resume"), false);
});

test("buildClaudeArgs includes model, append-system-prompt, add-dir, mcp-config, and permission-mode", () => {
  const args = buildClaudeArgs({
    prompt: "hello",
    cwd: "/tmp",
    model: "sonnet",
    appendSystemPrompt: "Be terse.",
    addDirs: ["/a", "/b"],
    mcpConfig: "/path/to/mcp.json",
    permissionMode: "default",
  });

  assert.equal(args[args.indexOf("--model") + 1], "sonnet");
  assert.equal(args[args.indexOf("--append-system-prompt") + 1], "Be terse.");
  assert.equal(args[args.indexOf("--mcp-config") + 1], "/path/to/mcp.json");
  assert.equal(args[args.indexOf("--permission-mode") + 1], "default");

  const addDirIndexes = args.reduce<number[]>((acc, arg, index) => {
    if (arg === "--add-dir") acc.push(index);
    return acc;
  }, []);
  assert.equal(addDirIndexes.length, 2);
  assert.equal(args[addDirIndexes[0] + 1], "/a");
  assert.equal(args[addDirIndexes[1] + 1], "/b");
});

test("buildClaudeArgs sets --dangerously-skip-permissions and suppresses --permission-mode", () => {
  const args = buildClaudeArgs({
    prompt: "hello",
    cwd: "/tmp",
    permissionMode: "default",
    dangerouslySkipPermissions: true,
  });

  assert.ok(args.includes("--dangerously-skip-permissions"));
  assert.equal(args.includes("--permission-mode"), false);
});

test("buildClaudeArgs appends extraArgs verbatim at the end", () => {
  const args = buildClaudeArgs({ prompt: "hello", cwd: "/tmp", extraArgs: ["--verbose", "--foo"] });
  assert.deepEqual(args.slice(-2), ["--verbose", "--foo"]);
});

test("buildClaudeArgs never includes the prompt text in argv", () => {
  const args = buildClaudeArgs({ prompt: "SECRET_PROMPT_TEXT", cwd: "/tmp" });
  assert.equal(args.includes("SECRET_PROMPT_TEXT"), false);
});
