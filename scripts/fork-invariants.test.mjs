// Fork invariants: fail when an upstream sync merges cleanly but silently
// brings back upstream behaviour. Git only reports conflicts; this reports
// the merges that "succeed" and still undo this fork. See docs/fork-releases.md.
import { createHash, createPublicKey } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  FORK_MACOS_BUNDLE_ID,
  FORK_NEW_ISSUE_URL,
  FORK_RELEASE_CHANNEL,
  FORK_RELEASES_URL,
  FORK_REPOSITORY,
  FORK_REPOSITORY_URL,
  FORK_VERSION_PATTERN,
  FORK_WINDOWS_UPDATE_KEYS,
  forkTrustedWindowsUpdateKeys,
} from "../apps/desktop/src/main/fork-config.mjs";
import * as sharedForkConfig from "../packages/shared/src/fork-config.ts";
import { WINDOWS_UPDATE_PUBLIC_KEYS } from "../apps/desktop/src/main/windows-update-trust.mjs";
import { assertCodeSigningCertificate } from "./fork-generate-macos-signing-certificates.mjs";
import { macDesignatedRequirement, macZipName, pinnedMacCertificates } from "./fork-macos-release.mjs";

const UPSTREAM = "tianma-if/edgeever";
const UPSTREAM_WINDOWS_KEY_ID = "edgeever-windows-update-2026-01";
const UPSTREAM_WINDOWS_PUBLIC_KEY = "MCowBQYDK2VwAyEAOuQwxSey8jGVqrvnkw9LgeBPmeqRieNg/KR0cpUy6RE=";
const root = join(import.meta.dir, "..");
const read = (file) => readFileSync(join(root, file), "utf8");

// The only upstream references allowed in shipped desktop/renderer code, each
// pointing at something this fork deliberately does not publish itself.
const ALLOWED_UPSTREAM = {
  "apps/web/src/components/NotebookPane.tsx": { count: 1, why: "Android APK: the fork publishes no mobile release" },
  "apps/web/src/components/settings/SystemInfoPanel.tsx": { count: 2, why: "release notes of the upstream server instance" },
  "apps/web/src/components/settings/PluginManagerCard.tsx": { count: 2, why: "upstream plugin development docs" },
  // Unreachable in the fork APK: app.config.ts disables expo-updates, which hides the update card.
  "apps/mobile/src/lib/mobile-release.ts": { count: 3, why: "upstream APK update check, disabled in fork builds" },
  "apps/mobile/src/screens/LoginScreen.tsx": { count: 1, why: "project homepage link on the login screen" },
  "packages/shared/src/font-catalog.ts": { count: 15, why: "poster fonts pinned to an upstream commit with sha256, not repository identity" },
};
const SCANNED = ["apps/desktop/src", "apps/web/src", "apps/mobile/src", "apps/mobile/modules", "packages/shared/src"];
// Also catches regex-escaped forms such as tianma-if\/edgeever, which hard-code
// the repository just as surely as a URL does. Matching runs in JavaScript:
// git grep -E does not match the escaped form consistently across platforms.
const UPSTREAM_LITERAL = /tianma-if\\?\/edgeever(?![-\w])/g;

// Tracked and new (untracked, not ignored) shipped source files.
const upstreamReferences = () => {
  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", ...SCANNED],
    { cwd: root, encoding: "utf8" }).split(/\r?\n/)
    .filter((file) => /\.(m?js|cjs|tsx?)$/.test(file) && !/\.(test|spec)\./.test(file) && existsSync(join(root, file)));
  return Object.fromEntries([...new Set(files)].flatMap((file) => {
    const count = (read(file).match(UPSTREAM_LITERAL) ?? []).length;
    return count ? [[file, count]] : [];
  }));
};

describe("fork identity", () => {
  test("points at this fork, not upstream, in both the desktop and renderer config", () => {
    expect(FORK_REPOSITORY).not.toBe(UPSTREAM);
    expect(FORK_REPOSITORY).toMatch(/^[\w.-]+\/[\w.-]+$/);
    for (const name of ["FORK_REPOSITORY", "FORK_REPOSITORY_URL", "FORK_RELEASES_URL", "FORK_NEW_ISSUE_URL"]) {
      expect(sharedForkConfig[name]).toBe({ FORK_REPOSITORY, FORK_REPOSITORY_URL, FORK_RELEASES_URL, FORK_NEW_ISSUE_URL }[name]);
    }
    expect(String(sharedForkConfig.FORK_VERSION_PATTERN)).toBe(String(FORK_VERSION_PATTERN));
    // /releases/latest omits pre-releases, and every fork release is one.
    expect(FORK_RELEASES_URL).not.toContain("/latest");
  });

  test("electron-builder publishes to and updates from this fork", () => {
    const builder = read("apps/desktop/electron-builder.yml");
    const [owner, repo] = FORK_REPOSITORY.split("/");
    expect(builder).toMatch(new RegExp(`publish:[\\s\\S]*?provider: github[\\s\\S]*?owner: ${owner}\\s[\\s\\S]*?repo: ${repo}\\s`));
    // The channel must come from the version (rc), never a fixed latest.yml.
    expect(builder).not.toMatch(/^\s*(channel|detectUpdateChannel)\s*:/m);
  });

  test("no new upstream repository literal appears in shipped desktop or renderer code", () => {
    expect(upstreamReferences()).toEqual(Object.fromEntries(Object.entries(ALLOWED_UPSTREAM).map(([file, { count }]) => [file, count])));
  }, 20_000);
});

describe("fork versions and update channel", () => {
  test("accepts only X.Y.Z-rc.N with a numeric counter", () => {
    expect(FORK_RELEASE_CHANNEL).toBe("rc");
    for (const ok of ["1.119.0-rc.0", "1.119.0-rc.10"]) expect(FORK_VERSION_PATTERN.test(ok)).toBe(true);
    // Bare versions outrank every rc; alpha/beta also accept stable releases.
    for (const bad of ["1.119.0", "1.119.0-alpha.1", "1.119.0-beta.1", "1.119.0-rc.01", "1.119.0-rc.1a", "v1.119.0-rc.1"]) {
      expect(FORK_VERSION_PATTERN.test(bad)).toBe(false);
    }
  });

  test("main keeps the upstream base version; the rc suffix is applied only at release time", () => {
    for (const file of ["package.json", "apps/desktop/package.json"]) {
      expect(JSON.parse(read(file)).version).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });
});

describe("fork Windows update trust", () => {
  // Pinned on purpose: replacing a key orphans every installed client, so a
  // change here must be a deliberate, reviewed edit of both files.
  test("pins exactly the generated primary and backup keys", () => {
    const fingerprint = (pem) => createHash("sha256").update(createPublicKey(pem).export({ type: "spki", format: "der" })).digest("hex");
    expect(fingerprint(FORK_WINDOWS_UPDATE_KEYS.primary.publicKeyPem)).toBe("1a383c020d4df0d48d77a715bee892e9c90527baf1ffb5d60172c2b8b46767a0");
    expect(fingerprint(FORK_WINDOWS_UPDATE_KEYS.backup.publicKeyPem)).toBe("22c1cb666119ae2907c7111083c346079907f67caf8621bc220748b703106f7d");
  });
  test("never trusts upstream's key, and only trusts this fork's primary and backup ids", () => {
    const ids = Object.keys(WINDOWS_UPDATE_PUBLIC_KEYS);
    expect(ids).not.toContain(UPSTREAM_WINDOWS_KEY_ID);
    expect(JSON.stringify(Object.values(WINDOWS_UPDATE_PUBLIC_KEYS))).not.toContain(UPSTREAM_WINDOWS_PUBLIC_KEY);
    const allowed = Object.values(FORK_WINDOWS_UPDATE_KEYS).map((key) => key.keyId);
    for (const id of ids) expect(allowed).toContain(id);
    expect(read("apps/desktop/src/main/windows-update-trust.mjs")).not.toContain(UPSTREAM_WINDOWS_PUBLIC_KEY);
  });

  // Enforced by the release workflow (EDGE_EVER_FORK_RELEASE=1); a release
  // without both pinned keys would ship a client that can never be rotated.
  test.skipIf(process.env.EDGE_EVER_FORK_RELEASE !== "1")("a release pins both keys, distinct and Ed25519", () => {
    const keys = forkTrustedWindowsUpdateKeys();
    expect(Object.keys(keys).sort()).toEqual(Object.values(FORK_WINDOWS_UPDATE_KEYS).map((key) => key.keyId).sort());
    const exported = Object.values(keys).map((pem) => {
      const key = createPublicKey(pem);
      expect(key.asymmetricKeyType).toBe("ed25519");
      return key.export({ type: "spki", format: "der" }).toString("base64");
    });
    expect(new Set(exported).size).toBe(2);
  });
});

describe("fork macOS update trust", () => {
  // Squirrel.Mac installs an update only if it satisfies the running app's
  // designated requirement, which names this bundle id.
  test("signs the bundle id electron-builder builds, as zip and dmg named as releases expect", () => {
    const builder = read("apps/desktop/electron-builder.yml");
    expect(builder).toMatch(new RegExp(`^appId: ${FORK_MACOS_BUNDLE_ID.replaceAll(".", "\\.")}\\s*$`, "m"));
    expect(builder).toMatch(/^mac:[\s\S]*?- target: dmg\s*\n\s*- target: zip\s*\n\s*artifactName: EdgeEver-\$\{version\}-mac-\$\{arch\}\.\$\{ext\}\s*$/m);
    expect(macZipName("1.0.0-rc.0", "arm64")).toBe("EdgeEver-1.0.0-rc.0-mac-arm64.zip");
  });

  // The release gate replaces an older signed app through this test mode.
  test("the update test mode still covers macOS", () => {
    expect(read("apps/desktop/src/main/index.mjs")).toMatch(
      /const linuxUpdateTestMode = \(process\.platform === "linux" \|\| process\.platform === "darwin"\)\s*\n\s*&& process\.env\.GITHUB_ACTIONS === "true"/,
    );
  });

  // Enforced by the release workflow (EDGE_EVER_FORK_RELEASE=1): a macOS
  // release must carry a requirement that a backup-signed release can satisfy.
  test.skipIf(process.env.EDGE_EVER_FORK_RELEASE !== "1")("a release pins two distinct code-signing certificates", () => {
    const { primary, backup } = pinnedMacCertificates();
    for (const { pem } of [primary, backup]) assertCodeSigningCertificate(pem);
    expect(primary.sha1).not.toBe(backup.sha1);
    expect(macDesignatedRequirement()).toContain(`identifier "${FORK_MACOS_BUNDLE_ID}"`);
  });
});

describe("fork Android app", () => {
  // Upstream OTA JavaScript (same runtimeVersion) would replace the fork's
  // encrypted-note client, and upstream APKs are signed with another key.
  test("never takes upstream OTA or APK updates", () => {
    const config = read("apps/mobile/app.config.ts");
    expect(config).toMatch(/updates:\s*\{[^}]*enabled:\s*false/);
    expect(read("apps/mobile/src/lib/mobile-update.tsx")).toMatch(/isSupported = !__DEV__ && Updates\.isEnabled/);
  });

  test("encrypted notes stay wired in", () => {
    expect(read("apps/mobile/src/screens/WorkspaceMemoDetail.tsx")).toContain("<MobileEncryptedNotePane");
    expect(read("apps/mobile/src/screens/WorkspaceScreen.tsx")).toMatch(/if \(isMobileEncryptedNote\(memo\.contentMarkdown\)\) return;/);
    expect(existsSync(join(root, "apps/mobile/modules/edgeever-crypto/android/src/main/java/org/edgeever/crypto/EncryptedNoteCrypto.java"))).toBe(true);
  });
});

describe("fork fixes kept across upstream syncs", () => {
  test("Windows ACP fixes are still wired in", () => {
    for (const file of ["acp-process-lifecycle.mjs", "claude-acp-compat.mjs"]) {
      expect(existsSync(join(root, "apps/desktop/src/main", file))).toBe(true);
    }
    const host = read("apps/desktop/src/main/acp-host.mjs");
    expect(host).toContain("./acp-process-lifecycle.mjs");
    expect(host).toContain("read-cmd-shim");
    expect(read("apps/desktop/src/main/acp-adapter-manager.mjs")).toContain("claude-acp-compat.mjs");
  });
});
