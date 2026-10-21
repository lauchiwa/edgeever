// Guards the fork's workflows: they run only in the fork, only the release's
// publish job can reach the Windows signing key and only its macos-sign job the
// macOS one (the build jobs only a read token), only the Android sign jobs the
// keystore, and upstream's snapshot sync stays out of the fork's own files.
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

  test("only the publish, macos-sign and android-sign jobs can reach a signing key, and they run nothing they install", () => {
    const text = workflow("fork-release.yml");
    const { windows, linux, macos, android, "macos-sign": macosSign, "macos-verify": macosVerify, "android-sign": androidSign, draft, publish, ...others } = jobsOf(text);
    expect(Object.keys(others)).toEqual([]);
    // Nothing outside the jobs (workflow env, defaults) may carry a secret,
    // and the default token cannot write.
    expect(text.slice(0, text.search(/^jobs:\s*$/m))).not.toMatch(/secrets\./);
    expect(text).toMatch(/^permissions:\s*\n  contents: read\s*\n/m);

    // The build jobs run npm dependencies: no key, no Environment, no write
    // token, no release changes. They only hand artifacts to draft.
    for (const build of [windows, linux, macos, android]) {
      expect(build).not.toMatch(/secrets\.|environment:|SIGNING|permissions:|gh release (?:create|upload|edit|delete)/);
      expect(build).not.toMatch(/fork-sign-release|sign-release/);
      // Directly or through the shared Android build action.
      expect(build).toMatch(/actions\/upload-artifact@|uses: \.\/\.github\/actions\/fork-android-build/);
    }
    // The signed apps are launched and updated without any key.
    expect(macosVerify).not.toMatch(/secrets\.|environment:|SIGNING|permissions:|sign-release|gh release/);
    expect(macosVerify).toMatch(/^    needs: macos-sign\s*$/m);

    // macos-sign holds the macOS key: Node only, no dependency install, the
    // workflow commit's scripts, and it can neither write nor touch the release.
    expect(macosSign).toMatch(/^    environment: fork-macos\s*$/m);
    expect(macosSign).toMatch(/^    needs: macos\s*$/m);
    expect([...macosSign.matchAll(/secrets\.(\w+)/g)].map((match) => match[1]).sort())
      .toEqual(["FORK_MACOS_SIGNING_KEY", "FORK_MACOS_SIGNING_PASSPHRASE"]);
    expect(macosSign).not.toMatch(/bun |npm |npx |pnpm |yarn |setup-bun|cache:|permissions:|GH_TOKEN|gh release/);
    expect(macosSign).toContain("ref: ${{ github.sha }}");
    expect(macosSign).toContain("persist-credentials: false");
    expect(macosSign).toContain("umask 077");
    expect(macosSign).toMatch(/trap 'rm -f "\$\{key\}"' EXIT/);
    expect(macosSign).toContain("node scripts/fork-macos-release.mjs sign-release");
    // android-sign holds the keystore, under the same rules as macos-sign.
    expect(androidSign).toMatch(/^    environment: fork-android\s*$/m);
    expect(androidSign).toMatch(/^    needs: android\s*$/m);
    expect([...androidSign.matchAll(/secrets\.(\w+)/g)].map((match) => match[1]).sort())
      .toEqual(["FORK_ANDROID_KEYSTORE_BASE64", "FORK_ANDROID_KEYSTORE_PASSWORD"]);
    expect(androidSign).not.toMatch(/bun |npm |npx |pnpm |yarn |setup-bun|setup-node|setup-java|cache:|permissions:|GH_TOKEN|gh release|\.\/\.github\/actions/);
    expect(androidSign).toContain("ref: ${{ github.sha }}");
    expect(androidSign).toContain("persist-credentials: false");
    expect(androidSign).toContain("umask 077");
    expect(androidSign).toMatch(/trap 'rm -f "\$\{keystore\}"' EXIT/);
    expect(androidSign).toContain("vars.FORK_ANDROID_SIGNER_SHA256");
    expect(androidSign).toContain("node scripts/fork-android-release.mjs stage");
    expect(androidSign).toContain("name: fork-release-android");
    expect(android).toContain("uses: ./.github/actions/fork-android-build");
    // Only publish's, macos-sign's and android-sign's secrets exist in the workflow.
    expect([...text.matchAll(/secrets\.(\w+)/g)].length).toBe(6);

    expect(draft).toMatch(/^    needs: \[windows, linux, macos-verify, android-sign\]\s*$/m);
    expect(draft).toMatch(/^    permissions:\s*\n      contents: write\s*$/m);
    expect(draft).not.toMatch(/secrets\.|environment:|actions\/checkout|bun |npm |node /);

    expect(publish).toMatch(/^    environment: fork-release\s*$/m);
    expect(publish).toMatch(/^    needs: draft\s*$/m);
    expect([...publish.matchAll(/secrets\.(\w+)/g)].map((match) => match[1]).sort())
      .toEqual(["FORK_WINDOWS_UPDATE_SIGNING_KEY", "FORK_WINDOWS_UPDATE_SIGNING_PASSPHRASE"]);
    expect(publish).not.toMatch(/bun |npm |npx |pnpm |yarn |setup-bun|cache:/);
    expect(publish).toContain("ref: ${{ github.sha }}");
    expect(publish).toContain("persist-credentials: false");
    expect(publish).toContain("umask 077");
    expect(publish).toMatch(/trap 'rm -f "\$\{key\}"' EXIT/);
    expect(publish).toContain('node scripts/fork-sign-release.mjs "${TAG}" --publish');
    // The audit re-checks the APK signer; the fingerprint is a variable, not a secret.
    expect(publish).toContain("EDGE_EVER_ANDROID_ALLOWED_SIGNER_SHA256: ${{ vars.FORK_ANDROID_SIGNER_SHA256 }}");
  });

  // Linux is published only after a real replacement of an older AppImage by
  // the staged one, served from the exact bytes the Draft receives.
  test("the Linux job verifies the package and a real AppImage update before staging", () => {
    const { linux } = jobsOf(workflow("fork-release.yml"));
    expect(linux).toMatch(/^    runs-on: ubuntu-22\.04\s*$/m);
    expect(linux).toContain("EDGE_EVER_DESKTOP_TARGET: linux");
    expect(linux).toContain("EDGE_EVER_VERIFY_TARGET: linux");
    expect(linux).toContain("verify:packaged-desktop-startup");
    const step = (name) => linux.search(new RegExp(`^\\s*- name: ${name}\\s*$`, "m"));
    const order = ["Get the update predecessor", "Package Linux AppImage", "Stage Linux assets", "Verify real AppImage automatic update"].map(step);
    expect(Math.min(...order)).toBeGreaterThan(-1);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(linux).toContain("node scripts/fork-linux-release.mjs stage");
    expect(linux).toContain("bun scripts/fork-verify-linux-appimage-update.mjs");
    expect(linux.indexOf("upload-artifact")).toBeGreaterThan(step("Verify real AppImage automatic update"));
  });

  // The publish job installs nothing, so the signing script must only import
  // Node built-ins and repository files (no npm package can reach the key).
  const importClosure = (entry) => {
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
    visit(join(root, "scripts", entry));
    return seen;
  };
  test("the signing scripts only import Node built-ins and repository files", () => {
    expect(importClosure("fork-sign-release.mjs").size).toBeGreaterThan(5);
    expect(importClosure("fork-macos-release.mjs").size).toBeGreaterThan(1);
    // macos-verify runs the gate without installing dependencies either.
    expect(importClosure("fork-verify-macos-app-update.mjs").size).toBeGreaterThan(1);
    // The maintainer generates the macOS certificates on a Mac with plain Node.
    expect(importClosure("fork-generate-macos-signing-certificates.mjs").size).toBeGreaterThan(2);
  });

  // macOS ships only signed apps that launched and replaced an older signed app.
  test("the macOS jobs build both architectures, sign once, then launch and update each signed app", () => {
    const { macos, "macos-sign": macosSign, "macos-verify": macosVerify } = jobsOf(workflow("fork-release.yml"));
    for (const job of [macos, macosVerify]) {
      expect(job).toMatch(/- arch: arm64\s*\n\s*runner: macos-15\s*$/m);
      expect(job).toMatch(/- arch: x64\s*\n\s*runner: macos-15-intel\s*$/m);
    }
    expect(macos).toContain('CSC_IDENTITY_AUTO_DISCOVERY: "false"');
    expect(macos).toContain("EDGE_EVER_VERIFY_TARGET: darwin");
    const step = (job, name) => job.search(new RegExp(`^\\s*- name: ${name}\\s*$`, "m"));
    const buildOrder = ["Get the update predecessor", "Package macOS app", "Keep the unsigned app", "Verify package"].map((name) => step(macos, name));
    expect(Math.min(...buildOrder)).toBeGreaterThan(-1);
    expect(buildOrder).toEqual([...buildOrder].sort((a, b) => a - b));
    expect(macos).toContain("shasum -a 256 -c -");
    expect(macosSign).toContain("name: fork-release-macos");
    expect(macosSign).toContain("name: fork-macos-predecessors");
    const verifyOrder = ["Check the signed assets", "Verify first launch of the signed app", "Verify real automatic update"].map((name) => step(macosVerify, name));
    expect(Math.min(...verifyOrder)).toBeGreaterThan(-1);
    expect(verifyOrder).toEqual([...verifyOrder].sort((a, b) => a - b));
    expect(macosVerify).toContain("verify:packaged-desktop-startup");
    expect(macosVerify).toContain("verify:desktop-protocol-e2e");
    expect(macosVerify).toContain("bun scripts/fork-verify-macos-app-update.mjs");
    expect(macosVerify).not.toContain("bun install");
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
    const { windows, linux, macos, android } = jobsOf(workflow("fork-release.yml"));
    // Android takes its version from app.json; it only shares the tag checks.
    expect(android).toContain("fork-release-version.mjs check");
    expect(android).toContain("merge-base --is-ancestor");
    for (const job of [windows, linux, macos]) {
      const step = (name) => job.search(new RegExp(`^\\s*- name: ${name}\\s*$`, "m"));
      const [gates, apply, build] = ["Release gates", "Apply the release version", "Build Web renderer"].map(step);
      expect(Math.min(gates, apply, build)).toBeGreaterThan(-1);
      expect(gates).toBeLessThan(apply);
      expect(apply).toBeLessThan(build);
      expect(job).toContain("fork-release-version.mjs check");
      expect(job).toContain("merge-base --is-ancestor");
    }
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

  // Test builds between releases: only the sign job, on manual dispatch, can
  // reach the fork keystore.
  test("only the Android sign job reaches the keystore, on dispatch, and it runs nothing it installs", () => {
    const text = workflow("fork-android.yml");
    const { build, sign, ...others } = jobsOf(text);
    expect(Object.keys(others)).toEqual([]);
    expect(text).toMatch(/^permissions:\s*\n\s*contents: read\s*\n/m);
    expect(text).not.toMatch(/contents: write|git push|gh release|--publish|tianma-if/);
    expect(text.slice(0, text.search(/^jobs:\s*$/m))).not.toMatch(/secrets\./);

    expect(build).not.toMatch(/secrets\.|environment:|KEYSTORE/);
    expect(build).toContain("uses: ./.github/actions/fork-android-build");

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
    // android-sign stages the APK with plain Node too.
    expect(importClosure("fork-android-release.mjs").size).toBeGreaterThan(1);
  });

  // The shared build runs npm dependencies: it takes no secret and keeps upstream OTA off.
  test("the shared Android build action never touches a key", () => {
    const action = readFileSync(join(root, ".github/actions/fork-android-build/action.yml"), "utf8");
    expect(action).not.toMatch(/secrets\.|vars\.|KEYSTORE|environment:|gh release/);
    expect(action).toContain('expo.modules.updates.ENABLED" android:value="false"');
    expect(action).toContain("-PreactNativeArchitectures=arm64-v8a");
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
