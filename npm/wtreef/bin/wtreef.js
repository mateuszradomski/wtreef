#!/usr/bin/env node
// Runs the wtreef binary built for this machine. npm installs exactly one of
// the optional @wtreef/<platform>-<arch> packages: the one whose os and cpu
// match. Arguments, stdio and the exit status pass straight through.
"use strict";

const { spawn } = require("node:child_process");
const { constants } = require("node:os");

const target = `${process.platform}-${process.arch}`;
const binaryName = process.platform === "win32" ? "wtreef.exe" : "wtreef";

let binary;
try {
  binary = require.resolve(`@wtreef/${target}/bin/${binaryName}`);
} catch {
  console.error(
    `wtreef: there is no build for ${target}. Builds exist for Linux, macOS and Windows on x64 and arm64.\n` +
      "If yours is one of them, the install skipped optional dependencies (--omit=optional?); reinstall without that.",
  );
  process.exit(1);
}

const child = spawn(binary, process.argv.slice(2), { stdio: "inherit" });
// Ctrl-C reaches the binary from the terminal directly; this covers signals
// sent to this process alone, e.g. by a process manager.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("error", (error) => {
  console.error(`wtreef: could not start ${binary}: ${error.message}`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  process.exit(signal === null ? (code ?? 1) : 128 + (constants.signals[signal] ?? 0));
});
