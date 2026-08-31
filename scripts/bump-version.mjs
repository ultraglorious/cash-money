// Set the app's release version everywhere it must agree, and say what to do next.
//
//   npm run release 0.1.1
//
// The updater compares the running app's version (from tauri.conf.json, baked
// in at build time) against the released one, so tauri.conf.json and Cargo.toml
// drifting apart either breaks the build or lies to the updater. This is the
// only supported way to change them. The npm package versions stay 0.0.0 —
// workspace-internal, never shipped.
//
// What the digits mean here (a personal app has no dependents, so semver's
// compatibility contract is repurposed for the one boundary that exists):
//
//   major  = BUDGET_FILE_VERSION. A major bump means the file format changed:
//            update every machine before saving from the new one, because an
//            older app refuses a newer file by design. Enforced below.
//   minor  = features.  patch = fixes.
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const confPath = join(root, "apps/desktop/src-tauri/tauri.conf.json");
const cargoPath = join(root, "apps/desktop/src-tauri/Cargo.toml");

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  console.error("usage: npm run release <major.minor.patch>   e.g. npm run release 0.1.1");
  process.exit(1);
}

// A release starts from a clean tree: the tag must point at exactly what was
// reviewed, not at whatever else happened to be lying around.
const dirty = execSync("git status --porcelain", { cwd: root })
  .toString()
  .split("\n")
  .filter((l) => l && !l.startsWith("??"));
if (dirty.length > 0) {
  console.error("refusing: the working tree has uncommitted changes:\n" + dirty.join("\n"));
  process.exit(1);
}

// major must equal the budget file version — that link is the entire point of
// the scheme, so it is checked rather than remembered.
const budgetFileSrc = readFileSync(join(root, "packages/core/src/persistence/budgetFile.ts"), "utf8");
const fileVersion = Number(/BUDGET_FILE_VERSION = (\d+)/.exec(budgetFileSrc)?.[1]);
const major = Number(version.split(".")[0]);
if (!Number.isInteger(fileVersion)) {
  console.error("refusing: couldn't read BUDGET_FILE_VERSION from packages/core");
  process.exit(1);
}
if (major !== fileVersion) {
  console.error(
    `refusing: the app's major version must equal the budget file version.\n` +
      `BUDGET_FILE_VERSION is ${fileVersion}, so this release must be ${fileVersion}.x.y (got ${version}).\n` +
      `If the file format really changed, bump BUDGET_FILE_VERSION in the same release.`,
  );
  process.exit(1);
}

const conf = JSON.parse(readFileSync(confPath, "utf8"));
const previous = conf.version;
conf.version = version;
writeFileSync(confPath, JSON.stringify(conf, null, 2) + "\n");

const cargo = readFileSync(cargoPath, "utf8");
const bumped = cargo.replace(/^version = "[^"]+"/m, `version = "${version}"`);
if (bumped === cargo && !cargo.includes(`version = "${version}"`)) {
  console.error("refusing: no version line found in Cargo.toml");
  process.exit(1);
}
writeFileSync(cargoPath, bumped);

// Cargo.lock records the workspace crate's own version too; refresh it so the
// lockfile commits alongside rather than dirtying the next build.
execSync("cargo update --workspace --quiet", { cwd: join(root, "apps/desktop/src-tauri"), stdio: "inherit" });

console.log(`${previous} -> ${version} in tauri.conf.json, Cargo.toml and Cargo.lock.\n`);
console.log("Next:");
console.log(`  git add -A apps/desktop/src-tauri && git commit -m "release: v${version}"`);
console.log(`  git push origin main && git push origin v${version}   # after: git tag v${version}`);
console.log("");
console.log("Then approve the run in GitHub Actions, install the DRAFT's setup.exe on the");
console.log("PC to smoke-test it, and only then publish the draft — publishing is what");
console.log("makes installed apps see it.");
