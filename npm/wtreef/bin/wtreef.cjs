#!/usr/bin/env node
// Runs the wtreef binary built for this machine. npm installs exactly one of
// the optional @wtreef/<platform>-<arch> packages: the one whose os and cpu
// match. Arguments, stdio and the exit status pass straight through.
//
// npm skips an optional package it cannot fetch without failing the install,
// e.g. one published seconds after wtreef itself, and npx then keeps reusing
// that install. So when the package is missing, the launcher downloads it
// from the registry once and accepts the binary only if it matches the
// SHA-256 that npm/build.mjs recorded in checksums.json.
"use strict";

const assert = require("node:assert");
const { spawn } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const { constants } = require("node:os");
const path = require("node:path");
const { gunzipSync } = require("node:zlib");

const REGISTRY_DEFAULT = "https://registry.npmjs.org/";
const DOWNLOAD_TIMEOUT_MS = 60_000;
const TARBALL_BYTES_MAX = 64 * 1024 * 1024;
const TAR_BLOCK_BYTES = 512;

if (require.main === module) {
  main().catch((error) => {
    console.error(`wtreef: ${error.message}`);
    process.exit(1);
  });
}

async function main() {
  const target = `${process.platform}-${process.arch}`;
  const binaryName = process.platform === "win32" ? "wtreef.exe" : "wtreef";
  const binary = installedBinary(target, binaryName) ?? (await downloadedBinary(target, binaryName));
  run(binary);
}

function installedBinary(target, binaryName) {
  try {
    return require.resolve(`@wtreef/${target}/bin/${binaryName}`);
  } catch {
    return null;
  }
}

async function downloadedBinary(target, binaryName) {
  const sha256 = require("../checksums.json")[target];
  if (sha256 === undefined) {
    throw new Error(`there is no build for ${target}. Builds exist for Linux, macOS and Windows on x64 and arm64.`);
  }
  assert.match(sha256, /^[0-9a-f]{64}$/);
  const binary = path.join(__dirname, "..", "downloaded", target, binaryName);
  if (fs.existsSync(binary)) {
    return binary;
  }
  const version = require("../package.json").version;
  const url = tarballURL(process.env.npm_config_registry || REGISTRY_DEFAULT, target, version);
  console.error(`wtreef: npm left out @wtreef/${target}; downloading ${url}`);
  const archive = gunzipSync(await fetchBytes(url));
  const content = tarEntry(archive, `package/bin/${binaryName}`);
  const actual = createHash("sha256").update(content).digest("hex");
  if (actual !== sha256) {
    throw new Error(`${url} holds a binary with SHA-256 ${actual}, expected ${sha256}`);
  }
  writeExecutable(binary, content);
  return binary;
}

function tarballURL(registry, target, version) {
  const base = registry.endsWith("/") ? registry : `${registry}/`;
  return `${base}@wtreef/${target}/-/${target}-${version}.tgz`;
}

async function fetchBytes(url) {
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`${url}: HTTP ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > TARBALL_BYTES_MAX) {
    throw new Error(`${url}: ${bytes.length} bytes, more than the ${TARBALL_BYTES_MAX} expected`);
  }
  return bytes;
}

// Reads a ustar archive as npm writes it: a 512-byte header per entry, then
// the content padded to whole blocks; a zero block ends the archive. Other
// entry types (pax headers, directories) are stepped over by their size.
function tarEntry(archive, wanted) {
  let offset = 0;
  while (offset + TAR_BLOCK_BYTES <= archive.length) {
    const header = archive.subarray(offset, offset + TAR_BLOCK_BYTES);
    if (header[0] === 0) {
      break;
    }
    const size = Number.parseInt(tarField(header, 124, 12), 8);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error(`the package archive has a bad entry size at byte ${offset}`);
    }
    const start = offset + TAR_BLOCK_BYTES;
    if (start + size > archive.length) {
      throw new Error("the package archive is truncated");
    }
    const prefix = tarField(header, 345, 155);
    const name = prefix === "" ? tarField(header, 0, 100) : `${prefix}/${tarField(header, 0, 100)}`;
    const isFile = header[156] === 0x30 || header[156] === 0;
    if (isFile && name === wanted) {
      return archive.subarray(start, start + size);
    }
    offset = start + Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
  }
  throw new Error(`the package archive has no ${wanted}`);
}

function tarField(header, start, length) {
  const field = header.subarray(start, start + length);
  const end = field.indexOf(0);
  return field.toString("utf8", 0, end === -1 ? length : end).trim();
}

// Written aside and renamed into place, so a launcher killed mid-write never
// leaves a partial binary that the next run would trust.
function writeExecutable(binary, content) {
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  const temporary = `${binary}.${process.pid}.partial`;
  fs.writeFileSync(temporary, content, { mode: 0o755 });
  fs.renameSync(temporary, binary);
}

function run(binary) {
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
}

module.exports = { tarEntry, tarballURL };
