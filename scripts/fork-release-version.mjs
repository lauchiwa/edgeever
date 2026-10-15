// Fork release versions: vX.Y.Z-rc.N (see docs/fork-releases.md).
//   X.Y.Z  the upstream version this fork is synced from (main keeps it bare)
//   N      this fork's releases on top of it, from 0
// A bare vX.Y.Z is never produced: SemVer ranks it above every -rc.N.
//
//   node scripts/fork-release-version.mjs next [X.Y.Z]   print the next free tag
//   node scripts/fork-release-version.mjs check <tag>     validate a tag
//   node scripts/fork-release-version.mjs apply <tag>     write it into package.json files (CI only)
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FORK_VERSION_PATTERN } from "../apps/desktop/src/main/fork-config.mjs";

const BASE = /^(\d+)\.(\d+)\.(\d+)$/;
// release-summary.json: the Web build requires its version to equal package.json
// (apps/web/vite.config.ts). Its notes stay upstream's for the base version.
export const VERSIONED_PACKAGES = ["package.json", "apps/desktop/package.json", "release-summary.json"];

export const parseForkTag = (tag) => {
  const version = String(tag ?? "").replace(/^v/, "");
  if (BASE.test(version)) {
    throw new Error(`${tag} is a bare upstream version; fork releases are vX.Y.Z-rc.N (a bare version outranks every rc and would pin installs to it)`);
  }
  const match = FORK_VERSION_PATTERN.exec(version);
  if (!match || !String(tag).startsWith("v")) throw new Error(`${tag} is not a fork release tag vX.Y.Z-rc.N`);
  return { tag: `v${version}`, version, base: match.slice(1, 4).join("."), core: match.slice(1, 4).map(Number), n: Number(match[4]) };
};

const compareCore = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

// Electron-updater picks the newest-published rc release, so tags must only
// ever increase: refuse a base below one already released.
export const nextForkTag = (base, existingTags) => {
  if (!BASE.test(base)) throw new Error(`Upstream base must be X.Y.Z, received: ${base}`);
  const core = base.split(".").map(Number);
  const fork = existingTags.flatMap((tag) => { try { return [parseForkTag(tag)]; } catch { return []; } });
  const higher = fork.find((release) => compareCore(release.core, core) > 0);
  if (higher) throw new Error(`${higher.tag} already exists above upstream ${base}; a lower base would never be offered as an update`);
  const n = Math.max(-1, ...fork.filter((release) => release.base === base).map((release) => release.n)) + 1;
  return `v${base}-rc.${n}`;
};

export const applyForkVersion = (tag, { root = process.cwd() } = {}) => {
  const { version, base } = parseForkTag(tag);
  for (const file of VERSIONED_PACKAGES) {
    const path = resolve(root, file);
    const text = readFileSync(path, "utf8");
    const current = JSON.parse(text).version;
    if (current !== base) throw new Error(`${file} is ${current}; tag ${tag} must be built from upstream base ${base}`);
    // Replace only the version field so formatting and key order are kept.
    writeFileSync(path, text.replace(`"version": "${current}"`, `"version": "${version}"`));
  }
  return version;
};

const run = () => {
  const [command, value] = process.argv.slice(2);
  if (command === "check") return void process.stdout.write(`${parseForkTag(value).tag}\n`);
  if (command === "apply") return void process.stdout.write(`${applyForkVersion(value)}\n`);
  if (command === "next") {
    const base = value ?? JSON.parse(readFileSync("package.json", "utf8")).version;
    const tags = execFileSync("git", ["tag", "--list", "v*"], { encoding: "utf8" }).split(/\r?\n/).filter(Boolean);
    return void process.stdout.write(`${nextForkTag(base, tags)}\n`);
  }
  throw new Error("Usage: fork-release-version.mjs next [X.Y.Z] | check <tag> | apply <tag>");
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();
