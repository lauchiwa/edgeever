// Syncs a formal upstream EdgeEver release into this fork through a reviewed
// pull request, never by pushing to main (main is protected; see
// docs/fork-releases.md). Only formal releases are followed, never upstream main.
//
//   node scripts/fork-sync-upstream.mjs status          latest upstream release; already merged?
//   node scripts/fork-sync-upstream.mjs start [vX.Y.Z]  create sync/vX.Y.Z from origin/main and merge it
//
// "start" never pushes. On a conflict it stops with the merge in progress so
// it can be resolved by hand: keep fork behaviour, then run the fork gates.
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const UPSTREAM_REPOSITORY = "tianma-if/edgeever";
export const UPSTREAM_URL = `https://github.com/${UPSTREAM_REPOSITORY}.git`;
// Upstream tags are kept out of refs/tags so `git push --tags` can never
// publish them to the fork (they would collide with no fork tag, but would
// look like fork releases on its Releases page).
const UPSTREAM_TAG_REF = (tag) => `refs/upstream-tags/${tag}`;
const STABLE_TAG = /^v\d+\.\d+\.\d+$/;
export const CONFLICT_EXIT_CODE = 3;

export const gitRunner = (cwd) => (args, { allowFailure = false } = {}) => {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    if (allowFailure) return null;
    throw new Error(`git ${args.join(" ")} failed: ${String(error.stderr || error.message).trim()}`);
  }
};

export const latestUpstreamRelease = () => {
  const tag = execFileSync("gh", ["api", `repos/${UPSTREAM_REPOSITORY}/releases/latest`, "--jq", ".tag_name"],
    { encoding: "utf8" }).trim();
  if (!STABLE_TAG.test(tag)) throw new Error(`Upstream latest release is not vX.Y.Z: ${tag}`);
  return tag;
};

const fetchUpstreamTag = (git, tag, upstreamUrl) => {
  if (!STABLE_TAG.test(tag)) throw new Error(`Only formal upstream releases vX.Y.Z are synced, received: ${tag}`);
  git(["fetch", "--no-tags", upstreamUrl, `+refs/tags/${tag}:${UPSTREAM_TAG_REF(tag)}`]);
  return git(["rev-parse", `${UPSTREAM_TAG_REF(tag)}^{commit}`]);
};

export const syncStatus = ({ git, tag, upstreamUrl = UPSTREAM_URL, base = "origin/main" }) => {
  git(["fetch", "origin", "main"]);
  const commit = fetchUpstreamTag(git, tag, upstreamUrl);
  const merged = git(["merge-base", "--is-ancestor", commit, base], { allowFailure: true }) !== null;
  return { tag, commit, merged, branch: `sync/${tag}` };
};

export const startSync = ({ git, tag, upstreamUrl = UPSTREAM_URL, base = "origin/main" }) => {
  if (git(["status", "--porcelain"])) {
    throw new Error("The working tree has uncommitted changes; commit or stash them before syncing");
  }
  const status = syncStatus({ git, tag, upstreamUrl, base });
  if (status.merged) return { ...status, result: "already_merged" };
  if (git(["rev-parse", "--verify", "--quiet", `refs/heads/${status.branch}`], { allowFailure: true })) {
    throw new Error(`Branch ${status.branch} already exists; continue there or delete it first`);
  }
  git(["switch", "-c", status.branch, base]);
  try {
    git(["merge", "--no-ff", "--no-edit", "-m", `Merge upstream EdgeEver ${tag} into ${status.branch}`, UPSTREAM_TAG_REF(tag)]);
  } catch (error) {
    const conflicts = (git(["diff", "--name-only", "--diff-filter=U"]) || "").split(/\r?\n/).filter(Boolean);
    // Only real conflicts are left for manual resolution. Anything else (for
    // example a missing git identity) is reported as git reported it.
    if (conflicts.length === 0) throw error;
    return { ...status, result: "conflicts", conflicts };
  }
  return { ...status, result: "merged" };
};

const nextSteps = (result) => [
  `Branch ${result.branch} now merges upstream ${result.tag}.`,
  "Next (nothing has been pushed):",
  "  1. bun install --frozen-lockfile",
  "  2. bun test scripts/fork-invariants.test.mjs && bun run typecheck && bun run typecheck:mobile && bun run build:web",
  `  3. git push -u origin ${result.branch}`,
  `  4. gh pr create -R lauchiwa/edgeever --base main --head ${result.branch} --title "Sync upstream EdgeEver ${result.tag}"`,
  `  5. After fork CI passes and the PR is merged: node scripts/fork-release-version.mjs next`,
].join("\n");

const run = () => {
  const [command, requested] = process.argv.slice(2);
  const git = gitRunner(process.cwd());
  const tag = requested ?? latestUpstreamRelease();
  if (command === "status") {
    const status = syncStatus({ git, tag });
    process.stdout.write(`${JSON.stringify(status)}\n`);
    return;
  }
  if (command !== "start") throw new Error("Usage: fork-sync-upstream.mjs status | start [vX.Y.Z]");
  const result = startSync({ git, tag });
  if (result.result === "already_merged") {
    process.stdout.write(`main already contains upstream ${tag}; nothing to sync.\n`);
  } else if (result.result === "conflicts") {
    process.stderr.write([
      `Merging upstream ${tag} into ${result.branch} stopped on conflicts:`,
      ...result.conflicts.map((file) => `  ${file}`),
      "Resolve them keeping this fork's behaviour (fork-config, Windows update trust, ACP fixes),",
      "then `git commit`, and run the gates listed in docs/fork-releases.md. Nothing has been pushed.",
      "",
    ].join("\n"));
    process.exitCode = CONFLICT_EXIT_CODE;
  } else {
    process.stdout.write(`${nextSteps(result)}\n`);
  }
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();
