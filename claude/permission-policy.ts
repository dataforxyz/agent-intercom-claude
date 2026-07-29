import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync,
  type BigIntStats,
} from "node:fs";
import { dirname, isAbsolute, join, parse, relative, sep } from "node:path";

export const CLAUDE_PERMISSION_MODES = [
  "acceptEdits",
  "auto",
  "bypassPermissions",
  "manual",
  "dontAsk",
  "plan",
] as const;

export type ClaudePermissionMode = (typeof CLAUDE_PERMISSION_MODES)[number];
export type ClaudePermissionCeiling = "standard" | "read-only";

export interface ClaudePermissionPolicyInput {
  permissionMode?: unknown;
  dangerouslySkipPermissions?: unknown;
  ceiling?: ClaudePermissionCeiling;
}

export interface ClaudePermissionPolicy {
  permissionMode?: ClaudePermissionMode;
  dangerouslySkipPermissions: boolean;
  ceiling: ClaudePermissionCeiling;
}

export function validateClaudePermissionMode(value: unknown, field = "permissionMode"): ClaudePermissionMode {
  if (typeof value !== "string" || !(CLAUDE_PERMISSION_MODES as readonly string[]).includes(value)) {
    throw new Error(`${field} must be one of: ${CLAUDE_PERMISSION_MODES.join(", ")}`);
  }
  return value as ClaudePermissionMode;
}

export function resolveClaudePermissionPolicy(input: ClaudePermissionPolicyInput): ClaudePermissionPolicy {
  const ceiling = input.ceiling ?? "standard";
  if (ceiling !== "standard" && ceiling !== "read-only") {
    throw new Error("permission ceiling must be standard or read-only");
  }
  if (input.dangerouslySkipPermissions !== undefined && typeof input.dangerouslySkipPermissions !== "boolean") {
    throw new Error("dangerouslySkipPermissions must be a boolean");
  }
  const dangerouslySkipPermissions = input.dangerouslySkipPermissions === true;
  const requestedMode = input.permissionMode === undefined
    ? undefined
    : validateClaudePermissionMode(input.permissionMode);

  if (ceiling === "read-only") {
    if (dangerouslySkipPermissions) {
      throw new Error("read-only Claude roles cannot skip permission checks");
    }
    if (requestedMode !== undefined && requestedMode !== "plan") {
      throw new Error("read-only Claude roles require permission mode plan");
    }
    // Claude applies the top-level plan-mode permission boundary to Task
    // subagents as well, so an inner agent cannot exceed this ceiling.
    return { permissionMode: "plan", dangerouslySkipPermissions: false, ceiling };
  }

  if (dangerouslySkipPermissions) {
    return { dangerouslySkipPermissions: true, ceiling };
  }
  return {
    permissionMode: requestedMode ?? "manual",
    dangerouslySkipPermissions: false,
    ceiling,
  };
}

const PERMISSION_OVERRIDE_OPTIONS = new Set([
  "--allow-dangerously-skip-permissions",
  "--dangerously-skip-permissions",
  "--permission-mode",
]);

// These options can load or grant permissions outside the validated top-level
// mode. They remain ordinary Claude CLI features, but a hardened launch must
// not be able to re-introduce them through appended argv.
export const CLAUDE_2_1_220_HARDENED_CAPABILITY_OPTIONS = [
  "--add-dir",
  "--agent",
  "--agents",
  "--allowed-tools",
  "--allowedTools",
  "--mcp-config",
  "--plugin-dir",
  "--plugin-dir-no-mcp",
  "--plugin-url",
  "--setting-sources",
  "--settings",
  "--tools",
  "--worktree",
  "-w",
] as const;

const HARDENED_PERMISSION_CAPABILITY_OPTIONS = new Set<string>(
  CLAUDE_2_1_220_HARDENED_CAPABILITY_OPTIONS,
);

function permissionCapabilityOption(arg: string): string | undefined {
  const equalsIndex = arg.indexOf("=");
  const option = equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);
  if (HARDENED_PERMISSION_CAPABILITY_OPTIONS.has(option)) return option;
  // Commander can interpret a single-dash token as a short option, an
  // attached value, or a cluster. Looking only at the first short option is
  // unsafe: for example, `-pwoutside` can still contain the root-creating
  // `-w` alias. Hardened roles therefore reject every appended single-dash
  // token. Standard roles retain the ordinary Claude CLI behavior.
  if (arg.length > 1 && arg.startsWith("-") && !arg.startsWith("--")) return arg;
  return undefined;
}

function isContainedPath(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === ""
    || (!isAbsolute(pathFromRoot) && pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`));
}

interface InspectedDirectory {
  canonicalPath: string;
  descriptor: BigIntStats;
}

export interface HardenedClaudePathBinding {
  cwd: string;
  addDirs: string[];
  release(): void;
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function pathError(field: string, detail: string, cause?: unknown): Error {
  return cause === undefined
    ? new Error(`${field} ${detail}`)
    : new Error(`${field} ${detail}`, { cause });
}

/**
 * Resolve a path without allowing lexical normalization to hide a symlink.
 * Each component is inspected before a later `..` component can remove it.
 */
function inspectExistingRealDirectory(input: string, base: string, field: string): InspectedDirectory {
  if (input.length === 0) {
    throw pathError(field, "must name an existing real directory");
  }
  const rawAbsolute = isAbsolute(input)
    ? input
    : `${base.endsWith(sep) ? base : `${base}${sep}`}${input}`;
  const root = parse(rawAbsolute).root;
  let cursor = root;

  const inspect = (path: string): BigIntStats => {
    let descriptor: BigIntStats;
    try {
      descriptor = lstatSync(path, { bigint: true });
    } catch (cause) {
      throw pathError(field, "must name an existing real directory", cause);
    }
    if (descriptor.isSymbolicLink()) {
      throw pathError(field, "must not contain a symbolic-link component");
    }
    if (!descriptor.isDirectory()) {
      throw pathError(field, "must contain only existing directories");
    }
    return descriptor;
  };

  let descriptor = inspect(cursor);
  for (const component of rawAbsolute.slice(root.length).split(sep)) {
    if (component === "" || component === ".") continue;
    cursor = component === ".." ? dirname(cursor) : join(cursor, component);
    descriptor = inspect(cursor);
  }

  let canonicalPath: string;
  try {
    canonicalPath = realpathSync(cursor);
  } catch (cause) {
    throw pathError(field, "cannot be bound to a canonical real directory", cause);
  }
  return { canonicalPath, descriptor };
}

function openBoundDirectory(input: string, base: string, field: string): { path: string; fd: number } {
  if (typeof constants.O_DIRECTORY !== "number" || typeof constants.O_NOFOLLOW !== "number") {
    throw pathError(field, "cannot be securely bound on this platform");
  }

  const first = inspectExistingRealDirectory(input, base, field);
  let fd: number;
  try {
    fd = openSync(first.canonicalPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch (cause) {
    throw pathError(field, "cannot be bound to an open real directory", cause);
  }

  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isDirectory() || !sameFile(opened, first.descriptor)) {
      throw pathError(field, "changed while its real directory was being bound");
    }

    // Re-walk the caller's spelling after opening the directory. This catches
    // a best-effort concurrent rename/symlink replacement and ensures only the
    // stable canonical spelling is ever returned to a launcher.
    const second = inspectExistingRealDirectory(input, base, field);
    if (second.canonicalPath !== first.canonicalPath || !sameFile(opened, second.descriptor)) {
      throw pathError(field, "changed while its real directory was being bound");
    }
    return { path: first.canonicalPath, fd };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

export function bindHardenedClaudePaths(
  cwd: string,
  addDirs: readonly string[],
  field = "hardened Claude paths",
): HardenedClaudePathBinding {
  const descriptors: number[] = [];
  try {
    const cwdBinding = openBoundDirectory(cwd, process.cwd(), `${field}.cwd`);
    descriptors.push(cwdBinding.fd);

    const canonicalAddDirs = addDirs.map((addDir, index) => {
      const binding = openBoundDirectory(addDir, cwdBinding.path, `${field}.addDirs[${index}]`);
      descriptors.push(binding.fd);
      if (!isContainedPath(cwdBinding.path, binding.path)) {
        throw pathError(`${field}.addDirs[${index}]`, "must stay within the assigned workspace root");
      }
      return binding.path;
    });

    let released = false;
    return {
      cwd: cwdBinding.path,
      addDirs: canonicalAddDirs,
      release() {
        if (released) return;
        released = true;
        for (const fd of descriptors.splice(0)) closeSync(fd);
      },
    };
  } catch (error) {
    for (const fd of descriptors) closeSync(fd);
    throw error;
  }
}

export function assertAddDirsWithinRoot(
  addDirs: readonly string[],
  root: string,
  field = "addDirs",
): void {
  const binding = bindHardenedClaudePaths(root, addDirs, field);
  binding.release();
}

export function assertNoPermissionOverrides(
  args: readonly string[],
  field = "claudeArgs",
  ceiling: ClaudePermissionCeiling = "standard",
): void {
  if (ceiling !== "read-only") return;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const option = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    if (PERMISSION_OVERRIDE_OPTIONS.has(option)) {
      throw new Error(`${field}[${index}] cannot override the validated Claude permission policy`);
    }
    if (ceiling === "read-only" && permissionCapabilityOption(arg) !== undefined) {
      throw new Error(`${field}[${index}] cannot add a permission capability to a hardened Claude role`);
    }
  }
}
