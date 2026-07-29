import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test from "node:test";
import { defaultWorkerConfig, loadWorkerConfig } from "./worker-config.ts";

const staticCapabilityInventory = JSON.parse(readFileSync(
  new URL("./fixtures/claude-2.1.220-static-capability-inventory.json", import.meta.url),
  "utf8",
)) as {
  rootCreatingOptionDeclarations: Array<{ declaration: string; effects: string[] }>;
};

function optionSpellingsFromStaticDeclaration(declaration: string): string[] {
  const matches = declaration.match(/(?:^|, )(-{1,2}[A-Za-z][A-Za-z-]*)/g) ?? [];
  return matches.map((match) => match.replace(/^, /, ""));
}

function withConfig(value: unknown, run: (path: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "claude-worker-config-"));
  const path = join(root, "worker.json");
  try {
    writeFileSync(path, JSON.stringify(value));
    run(path);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("default worker configuration preserves legacy omitted permission fields", () => {
  const agent = defaultWorkerConfig({ CLAUDE_INTERCOM_WORKER_CWD: "/tmp" }).agents[0]!;
  assert.equal(agent.permissionMode, undefined);
  assert.equal(agent.dangerouslySkipPermissions, undefined);
  assert.equal(agent.permissionCeiling, undefined);
});

test("Adversary and Council worker roles receive an immutable read-only ceiling", () => {
  for (const bossRole of ["adversary", "council"] as const) {
    withConfig({ agents: [{ id: bossRole, cwd: "/tmp", bossRole }] }, (path) => {
      const agent = loadWorkerConfig(path).agents[0]!;
      assert.equal(agent.permissionMode, "plan");
      assert.equal(agent.dangerouslySkipPermissions, false);
      assert.equal(agent.permissionCeiling, "read-only");
    });
  }
});

test("read-only worker configuration cannot widen itself or its subagent argv", () => {
  withConfig({ agents: [{ id: "reviewer", cwd: "/tmp", bossRole: "adversary", dangerouslySkipPermissions: true }] }, (path) => {
    assert.throws(() => loadWorkerConfig(path), /cannot skip permission checks/);
  });
  withConfig({ agents: [{ id: "reviewer", cwd: "/tmp", bossRole: "adversary", permissionMode: "acceptEdits" }] }, (path) => {
    assert.throws(() => loadWorkerConfig(path), /require permission mode plan/);
  });
  withConfig({ agents: [{ id: "reviewer", cwd: "/tmp", bossRole: "council", claudeArgs: ["--permission-mode", "bypassPermissions"] }] }, (path) => {
    assert.throws(() => loadWorkerConfig(path), /cannot override/);
  });
  for (const claudeArgs of [
    ["--allow-dangerously-skip-permissions"],
    ["--allowedTools=Edit"],
    ["--allowed-tools", "Bash"],
    ["--settings={\"permissions\":{\"defaultMode\":\"bypassPermissions\"}}"],
    ["--setting-sources", "project"],
    ["--agent", "unsafe"],
    ["--agents={\"unsafe\":{\"permissionMode\":\"bypassPermissions\"}}"],
    ["--plugin-dir", "/tmp/permission-hook"],
    ["--plugin-dir-no-mcp=/tmp/permission-hook"],
    ["--plugin-url=https://example.invalid/permission-hook.zip"],
    ["--add-dir", "/"],
    ["--mcp-config=/tmp/hostile.json"],
    ["--tools", "default"],
  ]) {
    withConfig({ agents: [{ id: "reviewer", cwd: "/tmp", bossRole: "adversary", claudeArgs }] }, (path) => {
      assert.throws(() => loadWorkerConfig(path), /cannot (?:override|add a permission capability)/);
    });
  }
});

test("read-only structured configuration rejects external roots and arbitrary MCP sources", () => {
  const temp = mkdtempSync(join(tmpdir(), "claude-worker-root-policy-"));
  const workspace = join(temp, "workspace");
  mkdirSync(workspace);
  mkdirSync(`${workspace}-escape`);
  mkdirSync(join(temp, "escape"));
  try {
    const evidence = join(workspace, "evidence");
    mkdirSync(evidence);
    withConfig({ agents: [{ id: "reviewer", cwd: workspace, bossRole: "adversary", addDirs: [evidence] }] }, (path) => {
      assert.deepEqual(loadWorkerConfig(path).agents[0]!.addDirs, [evidence]);
    });
    for (const addDir of ["/", `${workspace}-escape`, join(workspace, "..", "escape")]) {
      withConfig({ agents: [{ id: "reviewer", cwd: workspace, bossRole: "adversary", addDirs: [addDir] }] }, (path) => {
        assert.throws(() => loadWorkerConfig(path), /assigned workspace root/);
      });
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  withConfig({ agents: [{ id: "reviewer", cwd: "/tmp/workspace", bossRole: "council", mcpConfig: "/tmp/hostile-mcp.json" }] }, (path) => {
    assert.throws(() => loadWorkerConfig(path), /arbitrary MCP capability/);
  });
});

test("read-only worker config rejects every installed 2.1.220 worktree spelling and value form", () => {
  const rootCreators = staticCapabilityInventory.rootCreatingOptionDeclarations
    .filter((entry) => entry.effects.includes("creates-root"));
  assert.equal(rootCreators.length, 1);
  for (const option of rootCreators) {
    const spellings = optionSpellingsFromStaticDeclaration(option.declaration);
    const long = spellings.find((spelling) => spelling.startsWith("--"));
    const aliases = spellings.filter((spelling) => !spelling.startsWith("--"));
    assert.equal(long !== undefined, true);
    const hostileArgs = [
      [long!],
      [long!, "hostile-root"],
      [`${long}=hostile-root`],
      ...aliases.flatMap((alias) => [
        [alias],
        [alias, "hostile-root"],
        [`${alias}=hostile-root`],
        [`${alias}hostile-root`],
      ]),
    ];
    for (const claudeArgs of hostileArgs) {
      withConfig({ agents: [{ id: "reviewer", cwd: "/tmp", bossRole: "adversary", claudeArgs }] }, (path) => {
        assert.throws(() => loadWorkerConfig(path), /cannot add a permission capability/, claudeArgs.join(" "));
      });
    }
  }
});

test("read-only worker config rejects Commander short clusters before configuration is accepted", () => {
  for (const claudeArgs of [
    ["-pwoutside"],
    ["-wpoutside"],
    ["-pwxoutside"],
    ["-xwpoutside"],
    ["-x"],
    ["-pv"],
  ]) {
    withConfig({ agents: [{ id: "reviewer", cwd: "/tmp", bossRole: "council", claudeArgs }] }, (path) => {
      assert.throws(() => loadWorkerConfig(path), /cannot add a permission capability/, claudeArgs.join(" "));
    });
  }
});

test("ordinary workers retain non-permission Claude configuration arguments", () => {
  withConfig({ agents: [{
    id: "worker",
    cwd: "/tmp",
    addDirs: ["/"],
    mcpConfig: "/tmp/ordinary-mcp.json",
    claudeArgs: ["--settings", "/tmp/settings.json", "--plugin-dir-no-mcp=/tmp/plugin", "-pwoutside"],
  }] }, (path) => {
    const agent = loadWorkerConfig(path).agents[0]!;
    assert.deepEqual(agent.addDirs, ["/"]);
    assert.equal(agent.mcpConfig, "/tmp/ordinary-mcp.json");
    assert.deepEqual(agent.claudeArgs, ["--settings", "/tmp/settings.json", "--plugin-dir-no-mcp=/tmp/plugin", "-pwoutside"]);
  });
});

test("old ordinary worker JSON keeps omitted defaults while explicit safe mode remains explicit", () => {
  withConfig({ agents: [{ id: "old-worker", cwd: "/tmp" }] }, (path) => {
    const agent = loadWorkerConfig(path).agents[0]!;
    assert.equal(agent.permissionMode, undefined);
    assert.equal(agent.dangerouslySkipPermissions, undefined);
    assert.equal(agent.permissionCeiling, undefined);
  });
  withConfig({
    agents: [{
      id: "safe-worker",
      cwd: "/tmp",
      permissionMode: "manual",
      dangerouslySkipPermissions: false,
    }],
  }, (path) => {
    const agent = loadWorkerConfig(path).agents[0]!;
    assert.equal(agent.permissionMode, "manual");
    assert.equal(agent.dangerouslySkipPermissions, false);
    assert.equal(agent.permissionCeiling, undefined);
  });
});

test("read-only worker config requires real nonsymlink directories and stores canonical paths", () => {
  const temp = mkdtempSync(join(tmpdir(), "claude-worker-canonical-"));
  const workspace = join(temp, "workspace");
  const scratch = join(workspace, "scratch");
  const evidence = join(workspace, "evidence");
  const workspaceLink = join(temp, "workspace-link");
  mkdirSync(workspace);
  mkdirSync(scratch);
  mkdirSync(evidence);
  symlinkSync(workspace, workspaceLink);
  try {
    withConfig({
      agents: [{
        id: "reviewer",
        cwd: `${temp}${sep}.${sep}workspace`,
        bossRole: "adversary",
        addDirs: [`${scratch}${sep}..${sep}evidence`],
      }],
    }, (path) => {
      const agent = loadWorkerConfig(path).agents[0]!;
      assert.equal(agent.cwd, workspace);
      assert.deepEqual(agent.addDirs, [evidence]);
    });
    withConfig({ agents: [{ id: "reviewer", cwd: workspaceLink, bossRole: "council" }] }, (path) => {
      assert.throws(() => loadWorkerConfig(path), /must not contain a symbolic-link component/);
    });
    withConfig({
      agents: [{ id: "reviewer", cwd: workspace, bossRole: "council", addDirs: [join(workspace, "missing")] }],
    }, (path) => {
      assert.throws(() => loadWorkerConfig(path), /must name an existing real directory/);
    });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("worker configuration validates explicit permission modes", () => {
  withConfig({ agents: [{ id: "worker", cwd: "/tmp", permissionMode: "not-a-mode" }] }, (path) => {
    assert.throws(() => loadWorkerConfig(path), /must be one of/);
  });
});
