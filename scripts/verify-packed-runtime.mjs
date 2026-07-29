import { gunzipSync } from "node:zlib";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repositoryRoot = resolve(import.meta.dirname, "..");
const corePackage = "@dataforxyz/agent-intercom-core";
const coreDevSpec = "git+https://github.com/dataforxyz/agent-intercom-core.git#8316cbab548f422ad11c78ed887fabeef94817c1";
const coreConsumers = new Set([
  "broker.mjs",
  "cci.mjs",
  "ccim.mjs",
  "claude-server.mjs",
  "worker-daemon.mjs",
]);
const bundles = [...coreConsumers, "inbox-monitor.mjs"];

function tarString(buffer, offset, length) {
  const end = buffer.indexOf(0, offset);
  return buffer.subarray(offset, end === -1 || end > offset + length ? offset + length : end).toString("utf8");
}

function readTarEntries(archivePath) {
  const archive = gunzipSync(readFileSync(archivePath));
  const entries = new Map();
  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = tarString(header, 0, 100);
    const prefix = tarString(header, 345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    const sizeText = tarString(header, 124, 12).trim();
    const size = Number.parseInt(sizeText || "0", 8);
    if (!Number.isSafeInteger(size)) throw new Error(`Invalid tar size for ${path}`);
    const contentOffset = offset + 512;
    entries.set(path, archive.subarray(contentOffset, contentOffset + size));
    offset = contentOffset + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function createPackageArchive(temp) {
  const result = spawnSync("npm", [
    "pack",
    "--ignore-scripts",
    "--json",
    "--pack-destination",
    temp,
  ], {
    cwd: repositoryRoot,
    env: { ...process.env, npm_config_cache: join(temp, "npm-cache") },
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm pack failed: ${result.stderr || result.stdout}`);
  const packed = JSON.parse(result.stdout);
  if (!Array.isArray(packed) || packed.length !== 1 || typeof packed[0]?.filename !== "string") {
    throw new Error("npm pack did not report exactly one package archive");
  }
  return join(temp, packed[0].filename);
}

const archiveArgument = process.argv.indexOf("--archive");
const suppliedArchive = archiveArgument === -1 ? undefined : process.argv[archiveArgument + 1];
if (archiveArgument !== -1 && !suppliedArchive) throw new Error("--archive requires a package tarball path");
const temp = suppliedArchive ? undefined : mkdtempSync(join(tmpdir(), "claude-intercom-pack-check-"));

try {
  const archivePath = suppliedArchive ? resolve(suppliedArchive) : createPackageArchive(temp);
  const entries = readTarEntries(archivePath);
  const manifestEntry = entries.get("package/package.json");
  if (!manifestEntry) throw new Error("Packed adapter is missing package.json");
  const manifest = JSON.parse(manifestEntry.toString("utf8"));
  if (manifest.peerDependencies?.[corePackage] !== "0.1.0") throw new Error("Packed adapter must require Core peer 0.1.0");
  if (manifest.peerDependenciesMeta?.[corePackage]?.optional === true) throw new Error("Packed Core peer must not be optional");
  if (manifest.dependencies?.[corePackage] !== undefined) throw new Error("Packed adapter must not install a private Core dependency");
  if (manifest.devDependencies?.[corePackage] !== coreDevSpec) throw new Error("Packed adapter lost the approved Core build commit");
  if ([...entries.keys()].some((path) => path.includes("node_modules/@dataforxyz/agent-intercom-core/"))) {
    throw new Error("Packed adapter contains a private Core module tree");
  }

  for (const bundle of bundles) {
    const entry = entries.get(`package/dist/${bundle}`);
    if (!entry) throw new Error(`Packed adapter is missing dist/${bundle}`);
    const source = entry.toString("utf8");
    if (source.includes("node_modules/@dataforxyz/agent-intercom-core/") || /var POLICY_SEMANTICS_VERSION\s*=/.test(source)) {
      throw new Error(`Packed dist/${bundle} embeds a private Core copy`);
    }
    if (coreConsumers.has(bundle) && !/from ["']@dataforxyz\/agent-intercom-core(?:\/[A-Za-z/-]+)?["']/.test(source)) {
      throw new Error(`Packed dist/${bundle} does not retain its Core peer import`);
    }
  }
  console.log(`Verified ${bundles.length} packed bundles use required Core peer 0.1.0`);
} finally {
  if (temp) rmSync(temp, { recursive: true, force: true });
}
