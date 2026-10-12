// Stages the npm packages in bin/npm: one per platform holding its binary,
// and wtreef itself, which lists all of them as optional dependencies so npm
// installs only the one whose os and cpu match (esbuild's layout). Run it
// through `make npm VERSION=x.y.z`, which builds the frontend first so the
// binaries embed it.

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TARGETS = [
  { os: "linux", cpu: "x64", goos: "linux", goarch: "amd64" },
  { os: "linux", cpu: "arm64", goos: "linux", goarch: "arm64" },
  { os: "darwin", cpu: "x64", goos: "darwin", goarch: "amd64" },
  { os: "darwin", cpu: "arm64", goos: "darwin", goarch: "arm64" },
  { os: "win32", cpu: "x64", goos: "windows", goarch: "amd64" },
  { os: "win32", cpu: "arm64", goos: "windows", goarch: "arm64" },
];
const SCOPE = "@wtreef";
const OUTPUT = "bin/npm";
const DESCRIPTION = "See where your branch changes a codebase: a treemap of the repository with the changed files lit up.";

const version = process.argv[2] ?? "";
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`npm/build.mjs: VERSION must be semver like 0.1.0, got "${version}"`);
  process.exit(2);
}

rmSync(OUTPUT, { recursive: true, force: true });

for (const target of TARGETS) {
  const name = `${SCOPE}/${target.os}-${target.cpu}`;
  const directory = join(OUTPUT, `${target.os}-${target.cpu}`);
  const binary = join(directory, "bin", target.os === "win32" ? "wtreef.exe" : "wtreef");
  mkdirSync(join(directory, "bin"), { recursive: true });
  execFileSync("go", ["build", "-trimpath", "-ldflags=-s -w", "-o", binary, "./cmd/wtreef"], {
    stdio: "inherit",
    env: { ...process.env, GOOS: target.goos, GOARCH: target.goarch, CGO_ENABLED: "0" },
  });
  writeJson(join(directory, "package.json"), {
    name,
    version,
    description: `The ${target.os} ${target.cpu} binary of wtreef.`,
    os: [target.os],
    cpu: [target.cpu],
    preferUnplugged: true,
  });
  console.log(`staged ${name}`);
}

const main = join(OUTPUT, "wtreef");
mkdirSync(join(main, "bin"), { recursive: true });
copyFileSync("npm/wtreef/bin/wtreef.js", join(main, "bin", "wtreef.js"));
copyFileSync("README.md", join(main, "README.md"));
writeJson(join(main, "package.json"), {
  name: "wtreef",
  version,
  description: DESCRIPTION,
  bin: { wtreef: "bin/wtreef.js" },
  engines: { node: ">=18" },
  optionalDependencies: Object.fromEntries(TARGETS.map((target) => [`${SCOPE}/${target.os}-${target.cpu}`, version])),
});
console.log("staged wtreef");

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
