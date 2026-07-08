// ccim — the minimal counterpart to cci (like Codex's coim to coi).
// Identical to `cci` but forces minimal mode (--safe-mode woken turns), which
// strips CLAUDE.md, skills, plugins, hooks, and MCP while keeping built-in tools
// and subagent delegation. Everything else (flags, identity, yolo/--safe) is the
// same as cci; `ccim ...` is exactly `cci --minimal ...`.
import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { parseCciArgs, runCci } from "./cci.ts";

async function main(): Promise<void> {
  const options = { ...parseCciArgs(process.argv.slice(2)), minimal: true };
  const code = await runCci(options);
  process.exit(code);
}

// See cci.ts: match the real bundle file so the npm-bin symlink (basename
// "ccim", no extension) still triggers main().
function invokedFileBasename(): string {
  try {
    return process.argv[1] ? basename(realpathSync(process.argv[1])) : "";
  } catch {
    return process.argv[1] ? basename(process.argv[1]) : "";
  }
}

if (invokedFileBasename() === "ccim.ts" || invokedFileBasename() === "ccim.mjs") {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}
