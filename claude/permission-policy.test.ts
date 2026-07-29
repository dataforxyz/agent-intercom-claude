import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import {
  assertAddDirsWithinRoot,
  bindHardenedClaudePaths,
} from "./permission-policy.ts";

function withTempRoot(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "claude-add-dir-policy-"));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("hardened paths require an existing real directory for cwd and every addDir", () => {
  withTempRoot((root) => {
    const workspace = join(root, "workspace");
    const evidence = join(workspace, "evidence");
    mkdirSync(workspace);
    mkdirSync(evidence);
    writeFileSync(join(workspace, "file"), "not a directory");

    assert.doesNotThrow(() => assertAddDirsWithinRoot([evidence], workspace));
    assert.throws(
      () => assertAddDirsWithinRoot([], join(root, "missing-workspace")),
      /must name an existing real directory/,
    );
    assert.throws(
      () => assertAddDirsWithinRoot([join(workspace, "future")], workspace),
      /must name an existing real directory/,
    );
    assert.throws(
      () => assertAddDirsWithinRoot([join(workspace, "file", "child")], workspace),
      /must contain only existing directories/,
    );
  });
});

test("hardened paths reject every symlink component, including cwd and addDir", () => {
  withTempRoot((root) => {
    const workspace = join(root, "workspace");
    const outside = join(root, "outside");
    const rootLink = join(root, "workspace-link");
    mkdirSync(workspace);
    mkdirSync(outside);
    mkdirSync(join(workspace, "real"));
    symlinkSync(workspace, rootLink);
    symlinkSync(outside, join(workspace, "escape"));

    assert.throws(
      () => assertAddDirsWithinRoot([], rootLink),
      /must not contain a symbolic-link component/,
    );
    assert.throws(
      () => assertAddDirsWithinRoot([join(workspace, "escape")], workspace),
      /must not contain a symbolic-link component/,
    );
    assert.throws(
      () => assertAddDirsWithinRoot([`${workspace}${sep}escape${sep}..${sep}real`], workspace),
      /must not contain a symbolic-link component/,
    );
  });
});

test("hardened path binding returns only canonical contained spellings", () => {
  withTempRoot((root) => {
    const workspace = join(root, "workspace");
    const scratch = join(workspace, "scratch");
    const evidence = join(workspace, "evidence");
    mkdirSync(workspace);
    mkdirSync(scratch);
    mkdirSync(evidence);

    const binding = bindHardenedClaudePaths(
      `${root}${sep}.${sep}workspace`,
      [`${scratch}${sep}..${sep}evidence`, "."],
    );
    try {
      assert.equal(binding.cwd, resolve(workspace));
      assert.deepEqual(binding.addDirs, [resolve(evidence), resolve(workspace)]);
    } finally {
      binding.release();
      binding.release();
    }
  });
});

test("hardened addDirs reject real directories outside the canonical cwd", () => {
  withTempRoot((root) => {
    const workspace = join(root, "workspace");
    const outside = join(root, "outside");
    mkdirSync(workspace);
    mkdirSync(outside);
    assert.throws(
      () => assertAddDirsWithinRoot([outside], workspace),
      /must stay within the assigned workspace root/,
    );
  });
});
