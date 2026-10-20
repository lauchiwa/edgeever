import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { buildCodeSigningCertificate } from "./fork-generate-macos-signing-certificates.mjs";
import {
  MAC_CHECKSUM_FILE,
  MAC_UPDATE_CHANNEL_FILE,
  SIGNING_KEY_ENV,
  SIGNING_PASSPHRASE_ENV,
  loadMacSigningKey,
  macCertificateSha1,
  macDesignatedRequirement,
  macDmgName,
  macReleaseAssetNames,
  macSigningPlan,
  macZipName,
  pinnedMacCertificates,
  verifyMacRelease,
  verifyMacUpdateMetadata,
} from "./fork-macos-release.mjs";
import { writeMacRelease } from "./fork-macos-release.fixture.mjs";

const VERSION = "1.122.0-rc.1";
let root;

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "edgeever-fork-macos-")); });
afterEach(() => rm(root, { recursive: true, force: true }));

// 2048-bit keeps the tests fast; only the generator enforces RSA-3072.
const identity = (role) => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { privateKey, certificatePem: buildCodeSigningCertificate({ privateKey, publicKey, role }) };
};
const primary = identity("primary");
const backup = identity("backup");
const certificates = {
  primary: { certificatePem: primary.certificatePem },
  backup: { certificatePem: backup.certificatePem },
};

describe("fork macOS release names and trust", () => {
  test("ships an arm64 and an x64 zip and disk image, the rc channel file and a checksum list", () => {
    expect(MAC_UPDATE_CHANNEL_FILE).toBe("rc-mac.yml");
    expect(macReleaseAssetNames(VERSION)).toEqual([
      "EdgeEver-1.122.0-rc.1-mac-arm64.zip", "EdgeEver-1.122.0-rc.1-mac-arm64.dmg",
      "EdgeEver-1.122.0-rc.1-mac-x64.zip", "EdgeEver-1.122.0-rc.1-mac-x64.dmg",
      "rc-mac.yml", "SHA256SUMS-macos.txt",
    ]);
    // MacUpdater picks the arm64 file by "arm64" in its url.
    expect(macZipName(VERSION, "arm64")).toContain("arm64");
    expect(macZipName(VERSION, "x64")).not.toContain("arm64");
  });

  test("the designated requirement pins the bundle id and both certificates", () => {
    const pinned = pinnedMacCertificates(certificates);
    expect(pinned.primary.sha1).toMatch(/^[0-9a-f]{40}$/);
    expect(pinned.primary.sha1).toBe(macCertificateSha1(primary.certificatePem));
    expect(macDesignatedRequirement(certificates)).toBe(
      `identifier "org.edgeever.desktop" and (certificate leaf = H"${pinned.primary.sha1}" or certificate leaf = H"${pinned.backup.sha1}")`,
    );
  });

  test("refuses missing or identical pins", () => {
    expect(() => pinnedMacCertificates({ primary: { certificatePem: "" }, backup: certificates.backup })).toThrow("Pin both");
    expect(() => pinnedMacCertificates({ primary: certificates.primary, backup: certificates.primary })).toThrow("must differ");
  });
});

describe("fork macOS signing plan", () => {
  const macho = Buffer.from("cffaedfe0c000001", "hex");
  const plist = (executable) => `<plist><dict><key>CFBundleExecutable</key>\n<string>${executable}</string></dict></plist>`;
  const write = (path, content) => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  };

  // Creating the junction below occasionally stalls for seconds on Windows.
  test("signs nested code deepest first and the app last, skipping links and main executables", () => {
    const app = join(root, "EdgeEver.app");
    write(join(app, "Contents", "Info.plist"), plist("EdgeEver"));
    write(join(app, "Contents", "MacOS", "EdgeEver"), macho);
    const framework = join(app, "Contents", "Frameworks", "Electron Framework.framework");
    write(join(framework, "Versions", "A", "Resources", "Info.plist"), plist("Electron Framework"));
    write(join(framework, "Versions", "A", "Electron Framework"), macho);
    write(join(framework, "Versions", "A", "Libraries", "libffmpeg.dylib"), macho);
    symlinkSync(join(framework, "Versions", "A"), join(framework, "Versions", "Current"), "junction");
    const helper = join(app, "Contents", "Frameworks", "EdgeEver Helper.app");
    write(join(helper, "Contents", "Info.plist"), plist("EdgeEver Helper"));
    write(join(helper, "Contents", "MacOS", "EdgeEver Helper"), macho);
    const extension = join(app, "Contents", "PlugIns", "EdgeEverShare.appex");
    write(join(extension, "Contents", "Info.plist"), plist("EdgeEverShare"));
    write(join(extension, "Contents", "MacOS", "EdgeEverShare"), macho);
    write(join(app, "Contents", "Resources", "sidecar", "edgeever-sidecar"), macho);
    write(join(app, "Contents", "Resources", "app.asar"), "not code");

    const plan = macSigningPlan(app).map((item) => [item.path.slice(app.length + 1).replaceAll("\\", "/"), item.kind]);
    expect(plan).toEqual([
      ["Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/libffmpeg.dylib", "file"],
      ["Contents/Resources/sidecar/edgeever-sidecar", "file"],
      ["Contents/Frameworks/EdgeEver Helper.app", "bundle"],
      ["Contents/Frameworks/Electron Framework.framework", "bundle"],
      ["Contents/PlugIns/EdgeEverShare.appex", "extension"],
      ["", "app"],
    ]);
  }, 30_000);

  test("refuses anything but an app bundle", () => {
    expect(() => macSigningPlan(join(root, "missing.app"))).toThrow("Not an app bundle");
    expect(() => macSigningPlan(root)).toThrow("Not an app bundle");
  });
});

describe("fork macOS release audit", () => {
  const stage = () => join(root, "stage");

  test("accepts exactly the six assets with matching metadata and checksums", () => {
    writeMacRelease(stage(), VERSION);
    const result = verifyMacRelease(stage(), VERSION);
    expect(result.files.map((file) => file.name)).toEqual(macReleaseAssetNames(VERSION).slice(0, 4));
    const metadata = readFileSync(join(stage(), MAC_UPDATE_CHANNEL_FILE), "utf8");
    expect(metadata.split("\n").slice(0, 3)).toEqual([`version: ${VERSION}`, "files:", `  - url: ${macZipName(VERSION, "arm64")}`]);
    expect(metadata).toContain(`path: ${macZipName(VERSION, "arm64")}\n`);
  });

  test("refuses bare or non-fork versions", () => {
    writeMacRelease(stage(), VERSION);
    expect(() => verifyMacRelease(stage(), "1.122.0")).toThrow("X.Y.Z-rc.N");
  });

  test("rejects tampered zips, foreign metadata, wrong checksums, fake disk images and extra files", () => {
    writeMacRelease(stage(), VERSION);
    const zip = join(stage(), macZipName(VERSION, "x64"));
    const original = readFileSync(zip);
    writeFileSync(zip, Buffer.concat([original, Buffer.from("!")]));
    expect(() => verifyMacRelease(stage(), VERSION)).toThrow("exactly the");
    writeFileSync(zip, original);

    const metadataPath = join(stage(), MAC_UPDATE_CHANNEL_FILE);
    const metadata = readFileSync(metadataPath, "utf8");
    writeFileSync(metadataPath, `${metadata}stagingPercentage: 10\n`);
    expect(() => verifyMacRelease(stage(), VERSION)).toThrow("unexpected content");
    writeFileSync(metadataPath, metadata.replace(`version: ${VERSION}`, "version: 1.122.0-rc.0"));
    expect(() => verifyMacRelease(stage(), VERSION)).toThrow("exactly the");
    writeFileSync(metadataPath, metadata);
    expect(() => verifyMacUpdateMetadata({ metadata: metadata.replace(/releaseDate: .*/, "releaseDate: 'soon'"), version: VERSION, directory: stage() }))
      .toThrow("exactly the");

    const checksums = join(stage(), MAC_CHECKSUM_FILE);
    const sums = readFileSync(checksums, "utf8");
    writeFileSync(checksums, sums.split("\n").slice(1).join("\n"));
    expect(() => verifyMacRelease(stage(), VERSION)).toThrow(MAC_CHECKSUM_FILE);
    writeFileSync(checksums, sums);

    const dmg = join(stage(), macDmgName(VERSION, "arm64"));
    const image = readFileSync(dmg);
    writeFileSync(dmg, Buffer.concat([image, Buffer.alloc(16)]));
    expect(() => verifyMacRelease(stage(), VERSION)).toThrow("not a disk image");
    writeFileSync(dmg, image);

    writeFileSync(join(stage(), "latest-mac.yml"), metadata);
    expect(() => verifyMacRelease(stage(), VERSION)).toThrow("must contain exactly");
  });
});

describe("fork macOS signing key", () => {
  const passphrase = "macos signing passphrase 01";
  const keyFile = (key) => {
    const path = join(root, "key.pem");
    writeFileSync(path, key.export({ type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase }));
    return path;
  };
  const env = (path) => ({ GITHUB_ACTIONS: "true", [SIGNING_KEY_ENV]: path, [SIGNING_PASSPHRASE_ENV]: passphrase });

  test("loads only the encrypted primary key, only in GitHub Actions", () => {
    const path = keyFile(primary.privateKey);
    expect(loadMacSigningKey({ env: env(path), certificates }).certificatePem).toBe(primary.certificatePem);
    expect(() => loadMacSigningKey({ env: { ...env(path), GITHUB_ACTIONS: undefined }, certificates })).toThrow("macos-sign job");
    expect(() => loadMacSigningKey({ env: { ...env(path), [SIGNING_PASSPHRASE_ENV]: "" }, certificates })).toThrow("fork-macos environment");
    expect(() => loadMacSigningKey({ env: { ...env(path), [SIGNING_PASSPHRASE_ENV]: `${passphrase}x` }, certificates })).toThrow();
  });

  test("refuses an unencrypted key, the cold backup and unpinned keys", () => {
    const plain = join(root, "plain.pem");
    writeFileSync(plain, primary.privateKey.export({ type: "pkcs8", format: "pem" }));
    expect(() => loadMacSigningKey({ env: env(plain), certificates })).toThrow("passphrase-encrypted");
    expect(() => loadMacSigningKey({ env: env(keyFile(backup.privateKey)), certificates })).toThrow("cold backup");
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    expect(() => loadMacSigningKey({ env: env(keyFile(other)), certificates })).toThrow("does not match the pinned primary");
  });
});
