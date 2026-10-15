import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  WINDOWS_UPDATE_KEY_ID,
  WINDOWS_UPDATE_PUBLIC_KEYS,
  verifyDownloadedWindowsUpdate,
  verifyWindowsUpdateMetadata,
} from "./windows-update-trust.mjs";
import { FORK_WINDOWS_UPDATE_KEYS } from "./fork-config.mjs";

const VERSION = "1.49.0-rc.2";
const BACKUP_KEY_ID = FORK_WINDOWS_UPDATE_KEYS.backup.keyId;
const primary = generateKeyPairSync("ed25519");
const backup = generateKeyPairSync("ed25519");
const trustedPublicKeys = {
  [WINDOWS_UPDATE_KEY_ID]: primary.publicKey,
  [BACKUP_KEY_ID]: backup.publicKey,
};

const manifestFor = (overrides = {}) => ({
  schemaVersion: 1,
  keyId: WINDOWS_UPDATE_KEY_ID,
  version: VERSION,
  platform: "win32",
  arch: "x64",
  releaseDate: "2026-08-30T00:00:00.000Z",
  file: {
    name: `EdgeEver-${VERSION}-windows-x64.exe`,
    size: 7,
    sha512: "cLM86ckEfjD5F+fqE+Qvd2cAjD9PnJuvSeQ5D8YlVJ6WJe7jm5RUUHTooYJM8/I4RjsRvAPZc0jg/CmZyh//fw==",
    sha256: "239f59ed55e737c77147cf55ad0c1b030b6d7ee748a7426952f9b852d5a935e5",
  },
  ...overrides,
});

const updateInfoFor = (manifest) => ({
  version: manifest.version,
  files: [{ url: manifest.file.name, size: manifest.file.size, sha512: manifest.file.sha512 }],
});

const signed = (manifest, { privateKey = primary.privateKey, keyId = manifest.keyId } = {}) => {
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  return {
    manifestBytes,
    signatureBytes: Buffer.from(`${JSON.stringify({
      schemaVersion: 1,
      keyId,
      signature: sign(null, manifestBytes, privateKey).toString("base64"),
    })}\n`),
  };
};

const verifyWith = (manifest, signedValue = signed(manifest), keys = trustedPublicKeys) => verifyWindowsUpdateMetadata({
  ...signedValue,
  expectedVersion: manifest.version,
  updateInfo: updateInfoFor(manifest),
  trustedPublicKeys: keys,
});

describe("Windows update trust (fork)", () => {
  test("accepts a fork release signed by the primary key", () => {
    const manifest = manifestFor();
    expect(verifyWith(manifest)).toEqual(manifest);
  });

  test("accepts a key-rotation release signed by the cold backup key", () => {
    const manifest = manifestFor({ keyId: BACKUP_KEY_ID });
    expect(verifyWith(manifest, signed(manifest, { privateKey: backup.privateKey }))).toEqual(manifest);
  });

  test("rejects an envelope whose keyId disagrees with the signed manifest", () => {
    const manifest = manifestFor();
    // Signed by the backup key and labelled as such, but the manifest names the primary.
    expect(() => verifyWith(manifest, signed(manifest, { privateKey: backup.privateKey, keyId: BACKUP_KEY_ID })))
      .toThrow("fields are invalid");
  });

  test("rejects a signature labelled with one trusted key but made by another", () => {
    const manifest = manifestFor();
    expect(() => verifyWith(manifest, signed(manifest, { privateKey: backup.privateKey })))
      .toThrow("signature is invalid");
  });

  test("rejects metadata signed by any untrusted key", () => {
    const manifest = manifestFor();
    const { privateKey } = generateKeyPairSync("ed25519");
    expect(() => verifyWith(manifest, signed(manifest, { privateKey }))).toThrow("signature is invalid");
  });

  test("rejects bare upstream versions and non-rc pre-releases even when correctly signed", () => {
    for (const version of ["1.49.0", "1.49.0-beta.1", "1.49.0-rc.01", "1.49.0-rc.1a"]) {
      const manifest = manifestFor({ version, file: { ...manifestFor().file, name: `EdgeEver-${version}-windows-x64.exe` } });
      expect(() => verifyWith(manifest)).toThrow("fields are invalid");
    }
  });

  test("rejects the real upstream-signed manifest under the fork's pinned keys", () => {
    // Upstream v1.49.0 fixture, signed with upstream's private key.
    const upstream = {
      schemaVersion: 1, keyId: "edgeever-windows-update-2026-01", version: "1.49.0", platform: "win32", arch: "x64",
      releaseDate: "2026-08-30T00:00:00.000Z",
      file: { ...manifestFor().file, name: "EdgeEver-1.49.0-windows-x64.exe" },
    };
    const manifestBytes = Buffer.from(`${JSON.stringify(upstream, null, 2)}\n`);
    const signatureBytes = Buffer.from(`${JSON.stringify({
      schemaVersion: 1,
      keyId: upstream.keyId,
      signature: "Itc3UD0G6Hn6BWdk9qlJ4SoqAUDn8efi1VRVUWDtA3Ip5+gwpAj7HxElxM6D/GXcAlHFxnVv19soEWxlfZLCDA==",
    })}\n`);
    expect(Object.keys(WINDOWS_UPDATE_PUBLIC_KEYS)).not.toContain(upstream.keyId);
    expect(() => verifyWindowsUpdateMetadata({
      manifestBytes, signatureBytes, expectedVersion: upstream.version, updateInfo: updateInfoFor(upstream),
    })).toThrow();
  });

  test("fails closed with an explicit error when no keys are pinned", () => {
    const manifest = manifestFor();
    expect(() => verifyWith(manifest, signed(manifest), {})).toThrow("trust keys are not configured");
  });

  test("rejects a signed manifest that disagrees with latest.yml", () => {
    const manifest = manifestFor();
    expect(() => verifyWindowsUpdateMetadata({
      ...signed(manifest),
      expectedVersion: manifest.version,
      updateInfo: { ...updateInfoFor(manifest), files: [{ ...updateInfoFor(manifest).files[0], size: 8 }] },
      trustedPublicKeys,
    })).toThrow("does not match the signed manifest");
  });

  test("rejects update metadata that could select an extra installer", () => {
    const manifest = manifestFor();
    expect(() => verifyWindowsUpdateMetadata({
      ...signed(manifest),
      expectedVersion: manifest.version,
      updateInfo: {
        ...updateInfoFor(manifest),
        files: [{ url: "unexpected.exe", size: 1, sha512: manifest.file.sha512 }, ...updateInfoFor(manifest).files],
      },
      trustedPublicKeys,
    })).toThrow("exactly one trusted installer");
  });

  test("checks the downloaded installer size and both digests", async () => {
    const manifest = manifestFor();
    const directory = await mkdtemp(join(tmpdir(), "edgeever-windows-update-test-"));
    const path = join(directory, manifest.file.name);
    try {
      await writeFile(path, "payload");
      await expect(verifyDownloadedWindowsUpdate({ path, manifest })).resolves.toBe(true);
      await writeFile(path, "tampered");
      await expect(verifyDownloadedWindowsUpdate({ path, manifest })).rejects.toThrow("size does not match");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
