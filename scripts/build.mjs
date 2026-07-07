import { chmod } from "node:fs/promises";
import { build } from "esbuild";

const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
};

await Promise.all([
  build({
    ...common,
    entryPoints: ["claude/server.ts"],
    outfile: "dist/claude-server.mjs",
    banner: { js: "#!/usr/bin/env node" },
  }),
  build({
    ...common,
    entryPoints: ["broker/broker.ts"],
    outfile: "dist/broker.mjs",
  }),
  build({
    ...common,
    entryPoints: ["claude/worker-daemon.ts"],
    outfile: "dist/worker-daemon.mjs",
    banner: { js: "#!/usr/bin/env node" },
  }),
  build({
    ...common,
    entryPoints: ["claude/cci.ts"],
    outfile: "dist/cci.mjs",
    banner: { js: "#!/usr/bin/env node" },
  }),
]);

await Promise.all([
  chmod("dist/claude-server.mjs", 0o755),
  chmod("dist/worker-daemon.mjs", 0o755),
  chmod("dist/cci.mjs", 0o755),
]);
