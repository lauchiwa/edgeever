import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { gitRunner, startSync, syncStatus } from "./fork-sync-upstream.mjs";

// Each test spawns ~30 git processes; on Windows that exceeds the 5 s default.
const GIT_TIMEOUT = 60_000;

const identity = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
let root;
let saved;

const sh = (cwd, ...args) => {
  try {
    return execFileSync("git", ["-c", "core.autocrlf=false", ...args], { cwd, env: { ...process.env, ...identity }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    throw new Error(`git ${args.join(" ")} failed: ${error.stderr || error.message}`);
  }
};
const commitFile = async (cwd, file, content, message) => {
  await writeFile(join(cwd, file), content);
  sh(cwd, "add", file);
  sh(cwd, "commit", "-q", "-m", message);
};

// upstream: v1.0.0 -> v1.1.0. origin (fork): v1.0.0 + a fork commit on main. local: clone of origin.
const setup = async ({ conflicting }) => {
  const upstream = join(root, "upstream");
  sh(root, "init", "-q", "-b", "main", upstream);
  await commitFile(upstream, "app.txt", "upstream line\n", "base");
  await commitFile(upstream, "config.txt", "repo=tianma-if\n", "config");
  sh(upstream, "tag", "v1.0.0");
  sh(root, "clone", "-q", "--bare", upstream, join(root, "origin.git"));
  const local = join(root, "local");
  sh(root, "clone", "-q", join(root, "origin.git"), local);
  sh(local, "config", "core.autocrlf", "false");
  // The script's own merge commit runs through gitRunner without the test env;
  // CI runners have no global identity, so give the clone its own.
  sh(local, "config", "user.name", identity.GIT_AUTHOR_NAME);
  sh(local, "config", "user.email", identity.GIT_AUTHOR_EMAIL);
  await commitFile(local, "config.txt", "repo=lauchiwa\n", "fork: point at the fork");
  sh(local, "push", "-q", "origin", "main");
  if (conflicting) await commitFile(upstream, "config.txt", "repo=tianma-if\nchannel=latest\n", "upstream changes config");
  else await commitFile(upstream, "app.txt", "upstream line\nnew feature\n", "upstream feature");
  sh(upstream, "tag", "v1.1.0");
  return { upstream, local, git: gitRunner(local) };
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "edgeever-fork-sync-"));
  saved = Object.fromEntries(Object.keys(identity).map((key) => [key, process.env[key]]));
  Object.assign(process.env, identity);
}, GIT_TIMEOUT);
afterEach(async () => {
  for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : (process.env[key] = value);
  await rm(root, { recursive: true, force: true });
}, GIT_TIMEOUT);

describe("fork upstream sync", () => {
  test("merges a formal upstream release into sync/vX.Y.Z and keeps the fork change", async () => {
    const { upstream, local, git } = await setup({ conflicting: false });
    expect(syncStatus({ git, tag: "v1.1.0", upstreamUrl: upstream }).merged).toBe(false);
    const result = startSync({ git, tag: "v1.1.0", upstreamUrl: upstream });
    expect(result).toMatchObject({ result: "merged", branch: "sync/v1.1.0" });
    expect(sh(local, "branch", "--show-current")).toBe("sync/v1.1.0");
    expect(await readFile(join(local, "config.txt"), "utf8")).toBe("repo=lauchiwa\n");
    expect(await readFile(join(local, "app.txt"), "utf8")).toContain("new feature");
    // Nothing reached the fork's remote, and the fetched upstream tag stayed out
    // of refs/tags (v1.0.0 is there only because this test cloned it).
    expect(sh(local, "ls-remote", "--heads", "origin")).not.toContain("sync/");
    expect(sh(local, "tag", "--list", "v1.1.0")).toBe("");
    expect(sh(local, "rev-parse", "refs/upstream-tags/v1.1.0^{commit}")).toBe(sh(upstream, "rev-parse", "v1.1.0^{commit}"));
  }, GIT_TIMEOUT);

  test("stops on a conflict with the merge in progress and lists the files", async () => {
    const { upstream, local, git } = await setup({ conflicting: true });
    const result = startSync({ git, tag: "v1.1.0", upstreamUrl: upstream });
    expect(result).toMatchObject({ result: "conflicts", conflicts: ["config.txt"] });
    expect(sh(local, "rev-parse", "-q", "--verify", "MERGE_HEAD")).toMatch(/^[0-9a-f]{40}$/);
    expect(sh(local, "rev-parse", "main")).toBe(sh(local, "rev-parse", "origin/main"));
  }, GIT_TIMEOUT);

  test("reports a failed merge that is not a conflict instead of calling it one", async () => {
    const { upstream, local } = await setup({ conflicting: false });
    const real = gitRunner(local);
    // Simulates e.g. a missing git identity: the merge fails, nothing is unmerged.
    // Mirrors gitRunner: allowFailure returns null instead of throwing.
    const git = (args, options = {}) => {
      if (args[0] !== "merge") return real(args, options);
      if (options.allowFailure) return null;
      throw new Error("git merge failed: Committer identity unknown");
    };
    expect(() => startSync({ git, tag: "v1.1.0", upstreamUrl: upstream })).toThrow("Committer identity unknown");
  }, GIT_TIMEOUT);

  test("reports an already merged release without creating a branch", async () => {
    const { upstream, git } = await setup({ conflicting: false });
    expect(startSync({ git, tag: "v1.0.0", upstreamUrl: upstream })).toMatchObject({ result: "already_merged", merged: true });
    expect(git(["branch", "--list", "sync/*"])).toBe("");
  }, GIT_TIMEOUT);

  test("refuses a dirty tree, an existing branch, and anything but a formal release tag", async () => {
    const { upstream, local, git } = await setup({ conflicting: false });
    for (const tag of ["main", "v1.1.0-rc.0", "1.1.0"]) {
      expect(() => startSync({ git, tag, upstreamUrl: upstream })).toThrow("formal upstream releases");
    }
    sh(local, "branch", "sync/v1.1.0");
    expect(() => startSync({ git, tag: "v1.1.0", upstreamUrl: upstream })).toThrow("already exists");
    sh(local, "branch", "-D", "sync/v1.1.0");
    await writeFile(join(local, "app.txt"), "local edit\n");
    expect(() => startSync({ git, tag: "v1.1.0", upstreamUrl: upstream })).toThrow("uncommitted changes");
  }, GIT_TIMEOUT);
});
