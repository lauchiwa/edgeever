// Guards the fork's workflows: they run only in the fork, the release never
// signs in CI, and upstream's snapshot sync stays out of the fork's own files.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { FORK_REPOSITORY } from "../apps/desktop/src/main/fork-config.mjs";

const root = join(import.meta.dir, "..");
const workflow = (name) => readFileSync(join(root, ".github/workflows", name), "utf8");
const FORK_WORKFLOWS = ["fork-ci.yml", "fork-release.yml", "fork-upstream-watch.yml"];

describe("fork workflows", () => {
  test("every job runs only in this fork", () => {
    for (const name of FORK_WORKFLOWS) {
      const text = workflow(name);
      const jobsBlock = text.slice(text.search(/^jobs:\s*$/m));
      const jobs = [...jobsBlock.matchAll(/^  ([\w-]+):\s*$/gm)].map((match) => match[1]);
      const gates = [...jobsBlock.matchAll(/^    if: github\.repository == '([^']+)'\s*$/gm)].map((match) => match[1]);
      expect(jobs.length).toBeGreaterThan(0);
      expect(gates).toEqual(jobs.map(() => FORK_REPOSITORY));
    }
  });

  test("the release workflow never sees the signing key and only builds rc tags", () => {
    const text = workflow("fork-release.yml");
    expect(text).not.toMatch(/secrets\./);
    expect(text).not.toMatch(/SIGNING_KEY\s*:/);
    expect(text).not.toMatch(/sign-windows-update-manifest|fork-sign-release\.mjs v[^X]/);
    expect(text).toMatch(/tags:\s*\n\s*- "v\*-rc\.\*"/);
    expect(text).toContain("--draft --prerelease");
    expect(text).toContain("--publish never");
    expect(text).toContain("fork-release-version.mjs check");
    expect(text).toContain("merge-base --is-ancestor");
    expect(text).toContain('EDGE_EVER_FORK_RELEASE: "1"');
  });

  // The gates assert that main carries the bare upstream version, so they must
  // run on the tagged source before the rc version is written into it.
  test("the release gates run before the release version is applied, and both before the build", () => {
    const text = workflow("fork-release.yml");
    const step = (name) => text.search(new RegExp(`^\\s*- name: ${name}\\s*$`, "m"));
    const [gates, apply, build] = ["Release gates", "Apply the release version", "Build Web renderer"].map(step);
    expect(Math.min(gates, apply, build)).toBeGreaterThan(-1);
    expect(gates).toBeLessThan(apply);
    expect(apply).toBeLessThan(build);
  });

  test("CI and the watcher are read-only", () => {
    for (const name of ["fork-ci.yml", "fork-upstream-watch.yml"]) {
      expect(workflow(name)).toMatch(/permissions:\s*\n\s*contents: read\s*\n/);
      expect(workflow(name)).not.toMatch(/contents: write|git push/);
    }
  });

  test("fork workflow names never collide with upstream's", () => {
    for (const name of FORK_WORKFLOWS) expect(name.startsWith("fork-")).toBe(true);
  });
});
