import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { Worker } from "node:worker_threads";
import { buildClaudeArgs, runClaudeTurn } from "./cli-runner.ts";
import { CLAUDE_2_1_220_HARDENED_CAPABILITY_OPTIONS } from "./permission-policy.ts";

interface StaticCapabilityInventory {
  source: { package: string; version: string; binarySha256: string; elfBuildId: string; method: string };
  rootCreatingOptionDeclarations: Array<{ declaration: string; description: string; effects: string[] }>;
  options: Array<{ long: string; aliases: string[]; effects: string[] }>;
}

const staticCapabilityInventory = JSON.parse(readFileSync(
  new URL("./fixtures/claude-2.1.220-static-capability-inventory.json", import.meta.url),
  "utf8",
)) as StaticCapabilityInventory;

function optionSpellingsFromStaticDeclaration(declaration: string): string[] {
  const matches = declaration.match(/(?:^|, )(-{1,2}[A-Za-z][A-Za-z-]*)/g) ?? [];
  return matches.map((match) => match.replace(/^, /, ""));
}

test("buildClaudeArgs has the base -p --output-format json flags", () => {
  const args = buildClaudeArgs({ prompt: "hello", cwd: "/tmp" });
  assert.deepEqual(args.slice(0, 3), ["-p", "--output-format", "json"]);
  assert.equal(args.includes("--permission-mode"), false);
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
    permissionMode: "manual",
  });

  assert.equal(args[args.indexOf("--model") + 1], "sonnet");
  assert.equal(args[args.indexOf("--append-system-prompt") + 1], "Be terse.");
  assert.equal(args[args.indexOf("--mcp-config") + 1], "/path/to/mcp.json");
  assert.equal(args[args.indexOf("--permission-mode") + 1], "manual");

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
    permissionMode: "manual",
    dangerouslySkipPermissions: true,
  });

  assert.ok(args.includes("--dangerously-skip-permissions"));
  assert.equal(args.includes("--permission-mode"), false);
});

test("buildClaudeArgs appends extraArgs verbatim at the end", () => {
  const args = buildClaudeArgs({ prompt: "hello", cwd: "/tmp", extraArgs: ["--verbose", "--foo"] });
  assert.deepEqual(args.slice(-2), ["--verbose", "--foo"]);
});

test("buildClaudeArgs enforces a same-or-tighter read-only ceiling", () => {
  const args = buildClaudeArgs({ prompt: "review", cwd: "/tmp", permissionCeiling: "read-only" });
  assert.equal(args[args.indexOf("--permission-mode") + 1], "plan");
  assert.equal(args.includes("--bare"), true);
  assert.equal(args.includes("--dangerously-skip-permissions"), false);
  assert.throws(() => buildClaudeArgs({
    prompt: "review",
    cwd: "/tmp",
    permissionCeiling: "read-only",
    permissionMode: "acceptEdits",
  }), /require permission mode plan/);
  assert.throws(() => buildClaudeArgs({
    prompt: "review",
    cwd: "/tmp",
    permissionCeiling: "read-only",
    dangerouslySkipPermissions: true,
  }), /cannot skip permission checks/);
});

test("buildClaudeArgs rejects hardened permission overrides hidden in extra args", () => {
  assert.throws(() => buildClaudeArgs({
    prompt: "hello",
    cwd: "/tmp",
    permissionCeiling: "read-only",
    extraArgs: ["--permission-mode=bypassPermissions"],
  }), /cannot override/);
  assert.throws(() => buildClaudeArgs({
    prompt: "hello",
    cwd: "/tmp",
    permissionCeiling: "read-only",
    extraArgs: ["--dangerously-skip-permissions"],
  }), /cannot override/);
  assert.throws(() => buildClaudeArgs({
    prompt: "hello",
    cwd: "/tmp",
    permissionCeiling: "read-only",
    extraArgs: ["--allow-dangerously-skip-permissions"],
  }), /cannot override/);
  assert.deepEqual(buildClaudeArgs({
    prompt: "ordinary",
    cwd: "/tmp",
    extraArgs: ["--permission-mode=bypassPermissions"],
  }).slice(-1), ["--permission-mode=bypassPermissions"]);
});

test("Claude 2.1.220 hardened launches reject the independently inventoried capability and root options", () => {
  assert.deepEqual(staticCapabilityInventory.source, {
    package: "@anthropic-ai/claude-code",
    version: "2.1.220",
    binarySha256: "674f61f20ff306f3100cf9200e4c36c4b70278b5bef2884549819b942a89c863",
    elfBuildId: "788318c9115981678ca1a25f40cdb3b39df71403",
    method: "Static GNU strings inspection of the installed ELF option declarations; the executable was not invoked",
  });
  const independentlyInventoriedOptions = staticCapabilityInventory.options
    .flatMap((entry) => [entry.long, ...entry.aliases]);
  assert.deepEqual(CLAUDE_2_1_220_HARDENED_CAPABILITY_OPTIONS, independentlyInventoriedOptions);
  for (const option of CLAUDE_2_1_220_HARDENED_CAPABILITY_OPTIONS) {
    assert.throws(() => buildClaudeArgs({
      prompt: "review",
      cwd: "/tmp/workspace",
      permissionCeiling: "read-only",
      extraArgs: [`${option}=hostile`],
    }), /cannot add a permission capability/, option);
  }
  assert.throws(() => buildClaudeArgs({
    prompt: "review",
    cwd: "/tmp/workspace",
    permissionCeiling: "read-only",
    extraArgs: ["--", "prompt", "--plugin-dir-no-mcp=/tmp/plugin"],
  }), /cannot add a permission capability/);
});

test("installed Claude 2.1.220 worktree root creation is denied in every argv form before launch", () => {
  const rootCreators = staticCapabilityInventory.rootCreatingOptionDeclarations
    .filter((entry) => entry.effects.includes("creates-root"));
  assert.equal(rootCreators.length, 1);
  for (const option of rootCreators) {
    const spellings = optionSpellingsFromStaticDeclaration(option.declaration);
    const long = spellings.find((spelling) => spelling.startsWith("--"));
    const aliases = spellings.filter((spelling) => !spelling.startsWith("--"));
    assert.equal(long !== undefined, true);
    const hostileArgv = [
      [long!],
      [long!, "hostile-root"],
      [`${long}=hostile-root`],
      ["--", "prompt", long!, "hostile-root"],
      ["--", "prompt", `${long}=hostile-root`],
      ...aliases.flatMap((alias) => [
        [alias],
        [alias, "hostile-root"],
        [`${alias}=hostile-root`],
        [`${alias}hostile-root`],
        ["--", "prompt", alias, "hostile-root"],
      ]),
    ];
    for (const extraArgs of hostileArgv) {
      assert.throws(() => buildClaudeArgs({
        prompt: "review",
        cwd: "/tmp/workspace",
        permissionCeiling: "read-only",
        extraArgs,
      }), /cannot add a permission capability/, extraArgs.join(" "));
    }
  }
});

test("hardened launches reject Commander short clusters before spawn", () => {
  for (const extraArgs of [
    ["-pwoutside"],
    ["-wpoutside"],
    ["-pwxoutside"],
    ["-xwpoutside"],
    ["-x"],
    ["-pv"],
  ]) {
    assert.throws(() => buildClaudeArgs({
      prompt: "review",
      cwd: "/tmp/workspace",
      permissionCeiling: "read-only",
      extraArgs,
    }), /cannot add a permission capability/, extraArgs.join(" "));
  }
});

test("read-only structured roots and MCP config cannot widen the assigned workspace", () => {
  const temp = mkdtempSync(join(tmpdir(), "claude-root-policy-"));
  const workspace = join(temp, "workspace");
  mkdirSync(workspace);
  mkdirSync(`${workspace}-escape`);
  mkdirSync(join(temp, "escape"));
  try {
    mkdirSync(join(workspace, "evidence"));
    const within = buildClaudeArgs({
      prompt: "review",
      cwd: workspace,
      permissionCeiling: "read-only",
      addDirs: [workspace, join(workspace, "evidence")],
    });
    assert.equal(within.filter((arg) => arg === "--add-dir").length, 2);
    for (const addDir of ["/", `${workspace}-escape`, join(workspace, "..", "escape")]) {
      assert.throws(() => buildClaudeArgs({
        prompt: "review",
        cwd: workspace,
        permissionCeiling: "read-only",
        addDirs: [addDir],
      }), /assigned workspace root/, addDir);
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  assert.throws(() => buildClaudeArgs({
    prompt: "review",
    cwd: "/tmp/workspace",
    permissionCeiling: "read-only",
    mcpConfig: "/tmp/hostile-mcp.json",
  }), /arbitrary MCP capability/);
});

test("read-only structured roots reject a symlink escape before spawn", () => {
  const temp = mkdtempSync(join(tmpdir(), "claude-root-policy-"));
  const workspace = join(temp, "workspace");
  const outside = join(temp, "outside");
  mkdirSync(workspace);
  mkdirSync(outside);
  symlinkSync(outside, join(workspace, "escape"));
  try {
    assert.throws(() => buildClaudeArgs({
      prompt: "review",
      cwd: workspace,
      permissionCeiling: "read-only",
      addDirs: [join(workspace, "escape")],
    }), /must not contain a symbolic-link component/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("ordinary launches preserve explicit capability and bypass opt-ins", () => {
  const args = buildClaudeArgs({
    prompt: "ordinary",
    cwd: "/tmp/workspace",
    dangerouslySkipPermissions: true,
    addDirs: ["/"],
    mcpConfig: "/tmp/ordinary-mcp.json",
    extraArgs: ["--plugin-dir-no-mcp=/tmp/ordinary-plugin", "--worktree=ordinary-review", "-pwoutside"],
  });
  assert.equal(args.includes("--dangerously-skip-permissions"), true);
  assert.equal(args.includes("/"), true);
  assert.equal(args.includes("/tmp/ordinary-mcp.json"), true);
  assert.equal(args.includes("--plugin-dir-no-mcp=/tmp/ordinary-plugin"), true);
  assert.equal(args.includes("--worktree=ordinary-review"), true);
  assert.equal(args.includes("-pwoutside"), true);
});

test("hardened launches reject nonexistent cwd/addDirs and canonicalize every launched path", async () => {
  const temp = mkdtempSync(join(tmpdir(), "claude-canonical-launch-"));
  const workspace = join(temp, "workspace");
  const scratch = join(workspace, "scratch");
  const evidence = join(workspace, "evidence");
  const command = join(temp, "fake-claude.sh");
  mkdirSync(workspace);
  mkdirSync(scratch);
  mkdirSync(evidence);
  writeFileSync(command, [
    "#!/bin/sh",
    "cat >/dev/null",
    `printf '{"result":"cwd=%s;args=%s","is_error":false}\\n' "$PWD" "$*"`,
  ].join("\n"));
  chmodSync(command, 0o700);

  try {
    await assert.rejects(() => runClaudeTurn({
      prompt: "review",
      cwd: join(temp, "missing"),
      permissionCeiling: "read-only",
      claudeCommand: command,
    }), /must name an existing real directory/);
    await assert.rejects(() => runClaudeTurn({
      prompt: "review",
      cwd: workspace,
      permissionCeiling: "read-only",
      addDirs: [join(workspace, "missing")],
      claudeCommand: command,
    }), /must name an existing real directory/);

    const result = await runClaudeTurn({
      prompt: "review",
      cwd: `${temp}${sep}.${sep}workspace`,
      permissionCeiling: "read-only",
      addDirs: [`${scratch}${sep}..${sep}evidence`],
      claudeCommand: command,
    });
    assert.match(result.result, new RegExp(`^cwd=${resolve(workspace)};`));
    assert.match(result.result, new RegExp(`--add-dir ${resolve(evidence)}(?: |$)`));
    assert.equal(result.result.includes("scratch"), false);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("concurrent spelling replacement can only fail closed or launch canonical contained paths", async () => {
  const temp = mkdtempSync(join(tmpdir(), "claude-canonical-race-"));
  const assigned = join(temp, "assigned");
  const workspace = join(assigned, "workspace");
  const cwdGate = join(assigned, "cwd-gate");
  const addGate = join(workspace, "add-gate");
  const evidence = join(workspace, "evidence");
  const outside = join(temp, "outside");
  const outsideNested = join(outside, "nested");
  const command = join(temp, "fake-claude.sh");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(cwdGate);
  mkdirSync(addGate);
  mkdirSync(evidence);
  mkdirSync(outsideNested, { recursive: true });
  mkdirSync(join(outside, "workspace"));
  mkdirSync(join(outside, "evidence"));
  writeFileSync(command, [
    "#!/bin/sh",
    "cat >/dev/null",
    `printf '{"result":"cwd=%s;args=%s","is_error":false}\\n' "$PWD" "$*"`,
  ].join("\n"));
  chmodSync(command, 0o700);

  const flipper = new Worker(`
    const fs = require("node:fs");
    const { parentPort, workerData } = require("node:worker_threads");
    const wait = new Int32Array(new SharedArrayBuffer(4));
    function restore(path, held) {
      try { if (fs.lstatSync(path).isSymbolicLink()) fs.unlinkSync(path); } catch {}
      try { fs.renameSync(held, path); } catch {}
    }
    function flip(path, target) {
      const held = path + "-held";
      try {
        fs.renameSync(path, held);
        fs.symlinkSync(target, path);
        Atomics.wait(wait, 0, 0, 2);
        fs.unlinkSync(path);
        fs.renameSync(held, path);
        Atomics.wait(wait, 0, 0, 12);
      } catch {
        restore(path, held);
      }
    }
    const end = Date.now() + 750;
    while (Date.now() < end) {
      flip(workerData.cwdGate, workerData.outsideNested);
      flip(workerData.addGate, workerData.outsideNested);
    }
    restore(workerData.cwdGate, workerData.cwdGate + "-held");
    restore(workerData.addGate, workerData.addGate + "-held");
    parentPort.postMessage("done");
  `, {
    eval: true,
    workerData: { cwdGate, addGate, outsideNested },
  });
  const flipperDone = new Promise<void>((resolveDone, rejectDone) => {
    flipper.once("message", () => resolveDone());
    flipper.once("error", rejectDone);
  });

  let successes = 0;
  let failClosed = 0;
  try {
    for (let attempt = 0; attempt < 24; attempt += 1) {
      try {
        const result = await runClaudeTurn({
          prompt: "review",
          cwd: `${cwdGate}${sep}..${sep}workspace`,
          permissionCeiling: "read-only",
          addDirs: [`${addGate}${sep}..${sep}evidence`],
          claudeCommand: command,
        });
        assert.match(result.result, new RegExp(`^cwd=${resolve(workspace)};`));
        assert.match(result.result, new RegExp(`--add-dir ${resolve(evidence)}(?: |$)`));
        assert.equal(result.result.includes("gate"), false);
        successes += 1;
      } catch (error) {
        assert.match(String(error), /must (?:name an existing real directory|not contain a symbolic-link component)|changed while/);
        failClosed += 1;
      }
    }
    assert.equal(successes + failClosed, 24);
    await flipperDone;
    const stableResult = await runClaudeTurn({
      prompt: "review",
      cwd: `${cwdGate}${sep}..${sep}workspace`,
      permissionCeiling: "read-only",
      addDirs: [`${addGate}${sep}..${sep}evidence`],
      claudeCommand: command,
    });
    assert.match(stableResult.result, new RegExp(`^cwd=${resolve(workspace)};`));
    assert.match(stableResult.result, new RegExp(`--add-dir ${resolve(evidence)}(?: |$)`));
    assert.equal(stableResult.result.includes("gate"), false);
  } finally {
    await flipper.terminate();
    rmSync(temp, { recursive: true, force: true });
  }
});

test("buildClaudeArgs never includes the prompt text in argv", () => {
  const args = buildClaudeArgs({ prompt: "SECRET_PROMPT_TEXT", cwd: "/tmp" });
  assert.equal(args.includes("SECRET_PROMPT_TEXT"), false);
});
