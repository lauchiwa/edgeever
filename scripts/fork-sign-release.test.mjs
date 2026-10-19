import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { FORK_WINDOWS_UPDATE_KEYS } from "../apps/desktop/src/main/fork-config.mjs";
import { createWindowsUpdateMetadata } from "./create-windows-update-metadata.mjs";
import { writeLinuxBuild } from "./fork-linux-release.fixture.mjs";
import { linuxAppImageName, linuxReleaseAssetNames } from "./fork-linux-release.mjs";
import { writeMacRelease } from "./fork-macos-release.fixture.mjs";
import { macDmgName, macReleaseAssetNames, macZipName } from "./fork-macos-release.mjs";
import { SIGNING_PASSPHRASE_ENV, releaseAssetNames, resolveSigningPassphrase, signAndPublishRelease } from "./fork-sign-release.mjs";

const TAG = "v1.119.0-rc.0";
const VERSION = "1.119.0-rc.0";
const PASSPHRASE = "release signing passphrase";
let root;
let keys;

// A Draft on GitHub, held in memory.
const fakeGitHub = (release) => ({
  release: (tag) => (tag === TAG && release ? { draft: release.draft, prerelease: release.prerelease, assets: Object.keys(release.files) } : undefined),
  download(_tag, names, directory) {
    mkdirSync(directory, { recursive: true });
    for (const name of names) if (release.files[name]) writeFileSync(join(directory, name), release.files[name]);
  },
  upload(_tag, path, { clobber = false } = {}) {
    const name = path.split(/[\\/]/).pop();
    if (release.files[name] && !clobber) throw new Error(`asset ${name} already exists`);
    release.files[name] = readFileSync(path);
  },
  publish() { release.draft = false; },
});

const draftRelease = async () => {
  const build = join(root, `ci-build-${Math.random().toString(36).slice(2)}`);
  mkdirSync(build);
  await writeFile(join(build, `EdgeEver-${VERSION}-windows-x64.exe`), "installer payload");
  await createWindowsUpdateMetadata({ directory: build, version: VERSION, trustedPublicKeys: keys.trusted });
  // CI stages rc-linux.yml from electron-builder's latest-linux.yml.
  writeLinuxBuild(build, VERSION);
  writeFileSync(join(build, "rc-linux.yml"), readFileSync(join(build, "latest-linux.yml")));
  writeFileSync(join(build, "SHA256SUMS-linux.txt"), `${createHash("sha256").update(readFileSync(join(build, linuxAppImageName(VERSION)))).digest("hex")}  ${linuxAppImageName(VERSION)}
`);
  writeMacRelease(build, VERSION);
  return { draft: true, prerelease: true, files: Object.fromEntries(releaseAssetNames(VERSION).map((name) => [name, readFileSync(join(build, name))])) };
};

const options = (gh, overrides = {}) => ({
  tag: TAG, gh, privateKeyPath: keys.primaryPath, passphrase: PASSPHRASE, trustedPublicKeys: keys.trusted,
  workDirectory: join(root, `work-${Math.random().toString(36).slice(2)}`), ...overrides,
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "edgeever-fork-sign-test-"));
  const primary = generateKeyPairSync("ed25519");
  const backup = generateKeyPairSync("ed25519");
  const write = (name, key) => {
    const path = join(root, name);
    writeFileSync(path, key.privateKey.export({ type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase: PASSPHRASE }));
    return path;
  };
  keys = {
    primaryPath: write("primary.pem", primary),
    backupPath: write("backup.pem", backup),
    trusted: { [FORK_WINDOWS_UPDATE_KEYS.primary.keyId]: primary.publicKey, [FORK_WINDOWS_UPDATE_KEYS.backup.keyId]: backup.publicKey },
  };
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe("fork release signing", () => {
  test("signs a Draft, audits a fresh download of every Windows, Linux and macOS asset, then publishes it", async () => {
    const release = await draftRelease();
    expect(Object.keys(release.files)).toEqual(expect.arrayContaining([...linuxReleaseAssetNames(VERSION), ...macReleaseAssetNames(VERSION)]));
    const gh = fakeGitHub(release);
    const result = await signAndPublishRelease(options(gh, { publish: true }));
    expect(result).toMatchObject({
      tag: TAG, signed: true, keyId: FORK_WINDOWS_UPDATE_KEYS.primary.keyId, appImage: linuxAppImageName(VERSION), published: true,
    });
    expect(result.macAssets.map((asset) => asset.name)).toEqual(macReleaseAssetNames(VERSION).slice(0, 4));
    expect(Object.keys(release.files)).toContain("latest-windows.json.sig");
    expect(release).toMatchObject({ draft: false, prerelease: true });
  });

  test("without --publish it stays a Draft; a second run re-audits without the key and publishes", async () => {
    const release = await draftRelease();
    const gh = fakeGitHub(release);
    expect((await signAndPublishRelease(options(gh))).published).toBe(false);
    expect(release.draft).toBe(true);
    const signature = release.files["latest-windows.json.sig"];
    const result = await signAndPublishRelease(options(gh, { publish: true, privateKeyPath: undefined, passphrase: undefined }));
    expect(result).toMatchObject({ signed: false, published: true });
    expect(release.files["latest-windows.json.sig"]).toBe(signature);
  });

  test("never publishes when GitHub serves a tampered installer", async () => {
    const release = await draftRelease();
    const gh = fakeGitHub(release);
    const upload = gh.upload;
    gh.upload = (tag, path, flags) => {
      upload(tag, path, flags);
      release.files[`EdgeEver-${VERSION}-windows-x64.exe`] = Buffer.from("tampered installer");
    };
    await expect(signAndPublishRelease(options(gh, { publish: true }))).rejects.toThrow();
    expect(release.draft).toBe(true);
  });

  test("never publishes when GitHub serves a tampered AppImage or Linux metadata", async () => {
    for (const name of [linuxAppImageName(VERSION), "rc-linux.yml", "SHA256SUMS-linux.txt"]) {
      const release = await draftRelease();
      release.files[name] = Buffer.concat([release.files[name], Buffer.from("x")]);
      await expect(signAndPublishRelease(options(fakeGitHub(release), { publish: true }))).rejects.toThrow();
      expect(release.draft).toBe(true);
    }
  });

  test("never publishes when GitHub serves a tampered macOS zip, disk image or metadata", async () => {
    for (const name of [macZipName(VERSION, "arm64"), macDmgName(VERSION, "x64"), "rc-mac.yml", "SHA256SUMS-macos.txt"]) {
      const release = await draftRelease();
      release.files[name] = Buffer.concat([release.files[name], Buffer.from("x")]);
      await expect(signAndPublishRelease(options(fakeGitHub(release), { publish: true }))).rejects.toThrow();
      expect(release.draft).toBe(true);
    }
  });

  test("refuses a Draft without its macOS assets", async () => {
    const release = await draftRelease();
    delete release.files[macZipName(VERSION, "x64")];
    await expect(signAndPublishRelease(options(fakeGitHub(release), { publish: true }))).rejects.toThrow("must contain exactly");
    expect(release.draft).toBe(true);
  });

  test("refuses a Draft without its Linux assets", async () => {
    const release = await draftRelease();
    delete release.files["rc-linux.yml"];
    await expect(signAndPublishRelease(options(fakeGitHub(release), { publish: true }))).rejects.toThrow("must contain exactly");
    expect(release.draft).toBe(true);
    expect(Object.keys(release.files)).not.toContain("latest-windows.json.sig");
  });

  test("refuses published, non-pre-release, missing, or unexpected asset sets, and untrusted keys", async () => {
    const published = { ...(await draftRelease()), draft: false };
    await expect(signAndPublishRelease(options(fakeGitHub(published)))).rejects.toThrow("already published");
    const stable = { ...(await draftRelease()), prerelease: false };
    await expect(signAndPublishRelease(options(fakeGitHub(stable)))).rejects.toThrow("pre-release");
    await expect(signAndPublishRelease(options(fakeGitHub(undefined)))).rejects.toThrow("No release");
    const extra = await draftRelease();
    extra.files["unexpected.exe"] = Buffer.from("x");
    await expect(signAndPublishRelease(options(fakeGitHub(extra)))).rejects.toThrow("must contain exactly");
    const other = generateKeyPairSync("ed25519");
    const otherPath = join(root, "other.pem");
    writeFileSync(otherPath, other.privateKey.export({ type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase: PASSPHRASE }));
    const fresh = await draftRelease();
    await expect(signAndPublishRelease(options(fakeGitHub(fresh), { privateKeyPath: otherPath, publish: true }))).rejects.toThrow("does not match");
    expect(fresh.draft).toBe(true);
    expect(Object.keys(fresh.files)).not.toContain("latest-windows.json.sig");
  });

  test("the cold backup key cannot sign a manifest that names the primary", async () => {
    const release = await draftRelease();
    await expect(signAndPublishRelease(options(fakeGitHub(release), { privateKeyPath: keys.backupPath, publish: true })))
      .rejects.toThrow("key metadata is invalid");
    expect(release.draft).toBe(true);
  });
});

describe("signing passphrase source", () => {
  const prompt = async () => "typed";

  test("GitHub Actions reads it from the Environment secret and fails clearly without it", async () => {
    expect(await resolveSigningPassphrase({ env: { GITHUB_ACTIONS: "true", [SIGNING_PASSPHRASE_ENV]: "from-secret" }, prompt })).toBe("from-secret");
    await expect(resolveSigningPassphrase({ env: { GITHUB_ACTIONS: "true" }, prompt })).rejects.toThrow("fork-release environment");
  });

  test("locally it is always prompted for, and a passphrase left in the environment is refused", async () => {
    expect(await resolveSigningPassphrase({ env: {}, prompt })).toBe("typed");
    await expect(resolveSigningPassphrase({ env: { [SIGNING_PASSPHRASE_ENV]: "leaked" }, prompt })).rejects.toThrow("only read in GitHub Actions");
  });
});
