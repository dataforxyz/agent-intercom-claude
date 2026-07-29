import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "..");
const corePackage = "@dataforxyz/agent-intercom-core";
const coreCommit = "8316cbab548f422ad11c78ed887fabeef94817c1";
const coreDevSpec = `git+https://github.com/dataforxyz/agent-intercom-core.git#${coreCommit}`;
const coreConsumers = new Set([
  "broker.mjs",
  "cci.mjs",
  "ccim.mjs",
  "claude-server.mjs",
  "worker-daemon.mjs",
]);

function assertExternalCore(bundleName: string, source: string): void {
  assert.equal(
    source.includes("node_modules/@dataforxyz/agent-intercom-core/"),
    false,
    `${bundleName} embeds a private Core copy`,
  );
  assert.equal(/var POLICY_SEMANTICS_VERSION\s*=/.test(source), false, `${bundleName} embeds Core policy constants`);
  if (coreConsumers.has(bundleName)) {
    assert.match(source, /from ["']@dataforxyz\/agent-intercom-core(?:\/[A-Za-z/-]+)?["']/, `${bundleName} must retain a Core peer import`);
  }
}

function productionTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return productionTypeScriptFiles(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

test("source and every built bundle use Core only through the runtime peer", () => {
  const buildSource = readFileSync(join(repositoryRoot, "scripts/build.mjs"), "utf8");
  assert.match(buildSource, /"@dataforxyz\/agent-intercom-core"/);
  assert.match(buildSource, /"@dataforxyz\/agent-intercom-core\/\*"/);

  const sourceSpecifiers = ["broker", "claude"]
    .flatMap((directory) => productionTypeScriptFiles(join(repositoryRoot, directory)))
    .flatMap((path) => readFileSync(path, "utf8").match(/@dataforxyz\/agent-intercom-core[^"'\s]*/g) ?? []);
  assert.equal(sourceSpecifiers.length > 0, true);
  for (const specifier of sourceSpecifiers) {
    assert.match(specifier, /^@dataforxyz\/agent-intercom-core(?:\/[A-Za-z/-]+)?$/);
    assert.equal(specifier.includes("/dist/"), false);
  }

  const distDir = join(repositoryRoot, "dist");
  const bundles = readdirSync(distDir).filter((file) => file.endsWith(".mjs"));
  assert.deepEqual(new Set(bundles), new Set([...coreConsumers, "inbox-monitor.mjs"]));
  for (const bundle of bundles) {
    assertExternalCore(bundle, readFileSync(join(distDir, bundle), "utf8"));
  }
});

test("the shipped package requires one exact, non-optional Core peer", () => {
  const manifest = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")) as {
    files?: string[];
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    peerDependenciesMeta?: Record<string, { optional?: boolean }>;
    devDependencies?: Record<string, string>;
  };
  assert.equal(manifest.files?.includes("dist/**/*"), true);
  assert.equal(manifest.peerDependencies?.[corePackage], "0.1.0");
  assert.equal(manifest.peerDependenciesMeta?.[corePackage]?.optional, undefined);
  assert.equal(manifest.dependencies?.[corePackage], undefined);
  assert.equal(manifest.devDependencies?.[corePackage], coreDevSpec);
});
