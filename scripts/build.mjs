import { chmod } from "node:fs/promises";
import { build } from "esbuild";

const common = {
  bundle: true,
  metafile: true,
  platform: "node",
  format: "esm",
  target: "node20",
  // Core is a runtime peer. Keep both its root entry point and every exported
  // subpath as imports so all adapter bundles share the consumer's one Core
  // module instance instead of embedding private copies.
  external: [
    "@dataforxyz/agent-intercom-core",
    "@dataforxyz/agent-intercom-core/*",
  ],
};

const buildResults = await Promise.all([
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
  build({
    ...common,
    entryPoints: ["claude/ccim.ts"],
    outfile: "dist/ccim.mjs",
    banner: { js: "#!/usr/bin/env node" },
  }),
  build({
    ...common,
    entryPoints: ["claude/inbox-monitor.ts"],
    outfile: "dist/inbox-monitor.mjs",
    banner: { js: "#!/usr/bin/env node" },
  }),
]);

for (const result of buildResults) {
  for (const input of Object.keys(result.metafile.inputs)) {
    if (input.includes("node_modules/@dataforxyz/agent-intercom-core/")) {
      throw new Error(`Core runtime was embedded in an adapter bundle through ${input}`);
    }
  }
}

await Promise.all([
  chmod("dist/claude-server.mjs", 0o755),
  chmod("dist/worker-daemon.mjs", 0o755),
  chmod("dist/cci.mjs", 0o755),
  chmod("dist/ccim.mjs", 0o755),
  chmod("dist/inbox-monitor.mjs", 0o755),
]);
