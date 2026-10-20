#!/usr/bin/env node
// Local checks for fork changes, faster than running every gate from scratch:
//
//   node scripts/fork-check.mjs          fork tests + both typechecks (incremental)
//   node scripts/fork-check.mjs --full   the same, plus build:web
//
// The typechecks run the repository's own `bun run typecheck` and
// `bun run typecheck:mobile` with --incremental, keeping TypeScript's build
// info under node_modules/.cache, so a small change rechecks only what it
// touches. This is a local shortcut only: fork-ci.yml still runs every gate
// from scratch on each pull request, and that run is what must pass.
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const CACHE_DIRECTORY = join(root, "node_modules", ".cache", "edgeever-fork");

// The fork's own tests; fork-ci.yml runs exactly these (a test keeps the two in step).
export const FORK_TESTS = [
  "scripts/fork-invariants.test.mjs",
  "scripts/fork-release-version.test.mjs",
  "scripts/fork-sync-upstream.test.mjs",
  "scripts/fork-sign-release.test.mjs",
  "scripts/fork-generate-update-keys.test.mjs",
  "scripts/fork-workflows.test.mjs",
  "scripts/windows-update-metadata.test.mjs",
  "scripts/fork-linux-release.test.mjs",
  "scripts/fork-macos-release.test.mjs",
  "scripts/fork-generate-macos-signing-certificates.test.mjs",
  "scripts/fork-check.test.mjs",
  "apps/desktop/src/main/windows-update-trust.test.mjs",
];

const incremental = (name) => ["--incremental", "--tsBuildInfoFile", join(CACHE_DIRECTORY, `${name}.tsbuildinfo`)];

export const checkSteps = ({ full }) => [
  { label: "fork tests", args: ["test", ...FORK_TESTS] },
  { label: "typecheck", args: ["run", "typecheck", ...incremental("typecheck")] },
  { label: "typecheck:mobile", args: ["run", "typecheck:mobile", ...incremental("typecheck-mobile")] },
  ...(full ? [{ label: "build:web", args: ["run", "build:web"] }] : []),
];

export const parseCheckArguments = (argv) => {
  const unknown = argv.filter((arg) => arg !== "--full");
  if (unknown.length) throw new Error(`Unknown option: ${unknown.join(", ")}`);
  return { full: argv.includes("--full") };
};

const main = () => {
  const options = parseCheckArguments(process.argv.slice(2));
  mkdirSync(CACHE_DIRECTORY, { recursive: true });
  for (const step of checkSteps(options)) {
    const started = Date.now();
    process.stdout.write(`\n== ${step.label}\n`);
    const result = spawnSync("bun", step.args, { cwd: root, stdio: "inherit" });
    const seconds = Math.round((Date.now() - started) / 1000);
    if (result.error) throw result.error;
    if (result.status !== 0) {
      process.stderr.write(`\n${step.label} failed after ${seconds}s\n`);
      process.exit(result.status ?? 1);
    }
    process.stdout.write(`== ${step.label} passed in ${seconds}s\n`);
  }
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
