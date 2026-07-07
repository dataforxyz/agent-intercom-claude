// ccim — the minimal counterpart to cci (like Codex's coim to coi).
// Identical to `cci` but forces minimal mode (--safe-mode woken turns), which
// strips CLAUDE.md, skills, plugins, hooks, and MCP while keeping built-in tools
// and subagent delegation. Everything else (flags, identity, yolo/--safe) is the
// same as cci; `ccim ...` is exactly `cci --minimal ...`.
import { basename } from "node:path";
import { parseCciArgs, runCci } from "./cci.ts";

async function main(): Promise<void> {
  const options = { ...parseCciArgs(process.argv.slice(2)), minimal: true };
  const code = await runCci(options);
  process.exit(code);
}

if (process.argv[1] && (basename(process.argv[1]) === "ccim.ts" || basename(process.argv[1]) === "ccim.mjs")) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}
