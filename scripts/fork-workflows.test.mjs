// Guards the fork's workflows: they run only in the fork, only the release's
// publish job can reach the signing key (and only the Android sign job the
// keystore), and upstream's snapshot sync stays out of the fork's own files.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { FORK_REPOSITORY } from "../apps/desktop/src/main/fork-config.mjs";

const root = join(import.meta.dir, "..");
const workflow = (name) => readFileSync(join(root, ".github/workflows", name), "utf8");
const FORK_WORKFLOWS = [
  "fork-android.yml",
  "fork-ci.yml",
  "fork-docker-image.yml",
  "fork-release.yml",
  "fork-upstream-watch.yml",
];

describe("fork workflows", () => {
  test("every job runs only in this fork", () => {
    for (const name of FORK_WORKFLOWS) {
      const text = workflow(name);
      const jobsBlock = text.slice(text.search(/^jobs:\s*$/m));
      const jobs = [...jobsBlock.matchAll(/^  ([\w-]+):\s*$/gm)].map((match) => match[1]);
      // The repository gate comes first; it may only be narrowed further by event.
      const gates = [
        ...jobsBlock.matchAll(/^    if: github\.repository == '([^']+)'(?: && github\.event_name == '[\w-]+')?\s*$/gm),
      ].map((match) => match[1]);
      expect(jobs.length).toBeGreaterThan(0);
      expect(gates).toEqual(jobs.map(() => FORK_REPOSITORY));
    }
  });

  // Each top-level job of a workflow, by id.
  const jobsOf = (text) => {
    const block = text.slice(text.search(/^jobs:\s*$/m));
    const starts = [...block.matchAll(/^  ([\w-]+):\s*$/gm)];
    return Object.fromEntries(starts.map((match, index) => [match[1], block.slice(match.index, starts[index + 1]?.index)]));
  };

  test("only the publish job can reach the signing key, and it runs nothing it installs", () => {
    const text = workflow("fork-release.yml");
    const { windows, publish, ...others } = jobsOf(text);
    expect(Object.keys(others)).toEqual([]);
    // Nothing outside the jobs (workflow env, defaults) may carry a secret.
    expect(text.slice(0, text.search(/^jobs:\s*$/m))).not.toMatch(/secrets\./);

    expect(windows).not.toMatch(/secrets\.|environment:|SIGNING/);
    expect(windows).not.toContain("fork-sign-release");

    expect(publish).toMatch(/^    environment: fork-release\s*$/m);
    expect(publish).toMatch(/^    needs: windows\s*$/m);
    expect([...publish.matchAll(/secrets\.(\w+)/g)].map((match) => match[1]).sort())
      .toEqual(["FORK_WINDOWS_UPDATE_SIGNING_KEY", "FORK_WINDOWS_UPDATE_SIGNING_PASSPHRASE"]);
    expect(publish).not.toMatch(/bun |npm |npx |pnpm |yarn |setup-bun|cache:/);
    expect(publish).toContain("ref: ${{ github.sha }}");
    expect(publish).toContain("persist-credentials: false");
    expect(publish).toContain("umask 077");
    expect(publish).toMatch(/trap 'rm -f "\$\{key\}"' EXIT/);
    expect(publish).toContain('node scripts/fork-sign-release.mjs "${TAG}" --publish');
  });

  // The publish job installs nothing, so the signing script must only import
  // Node built-ins and repository files (no npm package can reach the key).
  test("the signing script only imports Node built-ins and repository files", () => {
    const seen = new Set();
    const visit = (file) => {
      if (seen.has(file)) return;
      seen.add(file);
      const source = readFileSync(file, "utf8");
      for (const [, specifier] of source.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+"([^"]+)"/gm)) {
        if (specifier.startsWith("node:")) continue;
        expect(specifier).toMatch(/^\.\.?\//);
        visit(join(file, "..", specifier));
      }
    };
    visit(join(root, "scripts", "fork-sign-release.mjs"));
    expect(seen.size).toBeGreaterThan(5);
  });

  test("the release workflow only builds rc tags and only from main", () => {
    const text = workflow("fork-release.yml");
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

  // The server image ships the same reviewed rc tag as the desktop release and
  // never reaches the signing key or upstream's :latest channel.
  test("the server image workflow builds only rc tags from main, without secrets beyond the GHCR token", () => {
    const text = workflow("fork-docker-image.yml");
    const { test: verify, publish, ...others } = jobsOf(text);
    expect(Object.keys(others)).toEqual([]);
    expect(text).toMatch(/tags:\s*\n\s*- "v\*-rc\.\*"/);
    expect(text).toMatch(/^permissions:\s*\n\s*contents: read\s*\n/m);
    expect(text).not.toMatch(/environment:|SIGNING|contents: write/);
    expect([...text.matchAll(/secrets\.(\w+)/g)].map((match) => match[1])).toEqual(["GITHUB_TOKEN"]);
    expect(verify).toContain("fork-release-version.mjs check");
    expect(verify).toContain("merge-base --is-ancestor");
    expect(verify).toContain(".features.encryptedNotes == true");
    expect(publish).toMatch(/^    needs: test\s*$/m);
    expect(publish).toContain('image="ghcr.io/${GITHUB_REPOSITORY,,}"');
    const code = text.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
    expect(code).not.toMatch(/:latest\b|tianma-if/);
  });

  // The Android test APK is a workflow artifact, never a release asset. Only
  // the sign job, on manual dispatch, can reach the fork keystore.
  test("only the Android sign job reaches the keystore, on dispatch, and it runs nothing it installs", () => {
    const text = workflow("fork-android.yml");
    const { build, sign, ...others } = jobsOf(text);
    expect(Object.keys(others)).toEqual([]);
    expect(text).toMatch(/^permissions:\s*\n\s*contents: read\s*\n/m);
    expect(text).not.toMatch(/contents: write|git push|gh release|--publish|tianma-if/);
    expect(text.slice(0, text.search(/^jobs:\s*$/m))).not.toMatch(/secrets\./);

    expect(build).not.toMatch(/secrets\.|environment:|KEYSTORE/);
    expect(build).toContain('expo.modules.updates.ENABLED" android:value="false"');

    expect(sign).toMatch(/^    if: github\.repository == '[^']+' && github\.event_name == 'workflow_dispatch'\s*$/m);
    expect(sign).toMatch(/^    environment: fork-android\s*$/m);
    expect(sign).toMatch(/^    needs: build\s*$/m);
    expect([...sign.matchAll(/secrets\.(\w+)/g)].map((match) => match[1]).sort())
      .toEqual(["FORK_ANDROID_KEYSTORE_BASE64", "FORK_ANDROID_KEYSTORE_PASSWORD"]);
    expect(sign).not.toMatch(/bun |npm |npx |pnpm |yarn |setup-bun|setup-node|setup-java|cache:/);
    expect(sign).toContain("ref: ${{ github.sha }}");
    expect(sign).toContain("persist-credentials: false");
    expect(sign).toContain("umask 077");
    expect(sign).toMatch(/trap 'rm -f "\$\{keystore\}"' EXIT/);
    expect(sign).toContain("vars.FORK_ANDROID_SIGNER_SHA256");
    expect(sign).toContain("node scripts/verify-android-apk-signature.mjs");
  });

  test("the Android signer check only imports Node built-ins", () => {
    const source = readFileSync(join(root, "scripts", "verify-android-apk-signature.mjs"), "utf8");
    const specifiers = [...source.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+"([^"]+)"/gm)].map((match) => match[1]);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) expect(specifier).toMatch(/^node:/);
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
