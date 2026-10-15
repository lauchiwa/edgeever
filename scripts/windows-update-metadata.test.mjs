import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { FORK_WINDOWS_UPDATE_KEYS } from "../apps/desktop/src/main/fork-config.mjs";
import { createWindowsUpdateMetadata } from "./create-windows-update-metadata.mjs";
import {
  assertWindowsUpdateSigningKey,
  signWindowsUpdateManifest,
} from "./sign-windows-update-manifest.mjs";
import { verifyWindowsUpdateRelease } from "./verify-windows-update-release.mjs";

const VERSION = "1.49.0-rc.0";
const INSTALLER = `EdgeEver-${VERSION}-windows-x64.exe`;
const PRIMARY_ID = FORK_WINDOWS_UPDATE_KEYS.primary.keyId;
const BACKUP_ID = FORK_WINDOWS_UPDATE_KEYS.backup.keyId;
const PASSPHRASE = "correct horse battery staple";

const withDirectory = async (prefix, run) => {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  try { return await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
};

const keySet = () => {
  const primary = generateKeyPairSync("ed25519");
  const backup = generateKeyPairSync("ed25519");
  return { primary, backup, trusted: { [PRIMARY_ID]: primary.publicKey, [BACKUP_ID]: backup.publicKey } };
};

const writeEncryptedKey = (path, privateKey, passphrase = PASSPHRASE) => writeFile(path, privateKey.export({
  type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase,
}));

describe("Windows update release metadata (fork)", () => {
  test("creates fork-versioned installer metadata consumed by electron-updater and the trust gate", () => withDirectory("edgeever-windows-metadata-", async (directory) => {
    const { trusted } = keySet();
    await writeFile(join(directory, INSTALLER), "payload");
    const manifest = await createWindowsUpdateMetadata({ directory, version: VERSION, trustedPublicKeys: trusted });
    expect(manifest).toMatchObject({ keyId: PRIMARY_ID, version: VERSION, file: {
      name: INSTALLER, size: 7, sha256: "239f59ed55e737c77147cf55ad0c1b030b6d7ee748a7426952f9b852d5a935e5",
    } });
    // electron-updater fetches rc.yml for an X.Y.Z-rc.N client; latest.yml is never written.
    expect(await readFile(join(directory, "rc.yml"), "utf8")).toContain(`sha512: ${manifest.file.sha512}`);
    await expect(readFile(join(directory, "latest.yml"), "utf8")).rejects.toThrow();
    expect(await readFile(join(directory, "SHA256SUMS-windows.txt"), "utf8"))
      .toBe(`${manifest.file.sha256}  ${manifest.file.name}\n`);
  }));

  test("refuses bare upstream versions and keys the client does not pin", () => withDirectory("edgeever-windows-metadata-", async (directory) => {
    const { trusted } = keySet();
    await writeFile(join(directory, "EdgeEver-1.49.0-windows-x64.exe"), "payload");
    await expect(createWindowsUpdateMetadata({ directory, version: "1.49.0", trustedPublicKeys: trusted }))
      .rejects.toThrow("fork release X.Y.Z-rc.N");
    await expect(createWindowsUpdateMetadata({ directory, version: VERSION, keyId: "edgeever-windows-update-2026-01", trustedPublicKeys: trusted }))
      .rejects.toThrow("not pinned");
  }));

  test("signs with a passphrase-protected key, deriving the keyId from the key itself", () => withDirectory("edgeever-windows-signing-", async (directory) => withDirectory("edgeever-windows-keys-", async (keys) => {
    const { primary, backup, trusted } = keySet();
    const other = generateKeyPairSync("ed25519");
    await writeFile(join(directory, INSTALLER), "payload");
    // Keys live outside the release directory: the audit accepts exactly the release assets.
    const keyPath = join(keys, "primary.pem");
    await writeEncryptedKey(keyPath, primary.privateKey);

    expect(() => assertWindowsUpdateSigningKey({ privateKeyPath: keyPath, trustedPublicKeys: trusted }))
      .toThrow("passphrase is required");
    expect(() => assertWindowsUpdateSigningKey({ privateKeyPath: keyPath, passphrase: "wrong passphrase!!", trustedPublicKeys: trusted }))
      .toThrow("could not be decrypted");
    expect(assertWindowsUpdateSigningKey({ privateKeyPath: keyPath, passphrase: PASSPHRASE, trustedPublicKeys: trusted }).keyId)
      .toBe(PRIMARY_ID);

    await createWindowsUpdateMetadata({ directory, version: VERSION, trustedPublicKeys: trusted });
    const manifestPath = join(directory, "latest-windows.json");
    const signaturePath = `${manifestPath}.sig`;
    expect(signWindowsUpdateManifest({ manifestPath, signaturePath, privateKeyPath: keyPath, passphrase: PASSPHRASE, trustedPublicKeys: trusted }))
      .toMatchObject({ keyId: PRIMARY_ID });
    await expect(verifyWindowsUpdateRelease(directory, { trustedPublicKeys: trusted })).resolves.toMatchObject({ version: VERSION });

    // A trusted key that the manifest does not name is refused before signing.
    const backupPath = join(keys, "backup.pem");
    await writeEncryptedKey(backupPath, backup.privateKey);
    expect(() => signWindowsUpdateManifest({ manifestPath, signaturePath, privateKeyPath: backupPath, passphrase: PASSPHRASE, trustedPublicKeys: trusted }))
      .toThrow("key metadata is invalid");
    // A key the client does not pin is refused outright.
    const otherPath = join(keys, "other.pem");
    await writeEncryptedKey(otherPath, other.privateKey);
    expect(() => signWindowsUpdateManifest({ manifestPath, signaturePath, privateKeyPath: otherPath, passphrase: PASSPHRASE, trustedPublicKeys: trusted }))
      .toThrow("does not match");
  })));

  test("audits the complete release asset set, including a tampered installer", () => withDirectory("edgeever-windows-release-audit-", async (directory) => {
    const { primary, trusted } = keySet();
    const keyPath = join(tmpdir(), `edgeever-audit-key-${process.pid}-${Date.now()}.pem`);
    try {
      await writeFile(join(directory, INSTALLER), "payload");
      await writeEncryptedKey(keyPath, primary.privateKey);
      await createWindowsUpdateMetadata({ directory, version: VERSION, trustedPublicKeys: trusted });
      const manifestPath = join(directory, "latest-windows.json");
      signWindowsUpdateManifest({ manifestPath, signaturePath: `${manifestPath}.sig`, privateKeyPath: keyPath, passphrase: PASSPHRASE, trustedPublicKeys: trusted });
      await expect(verifyWindowsUpdateRelease(directory, { trustedPublicKeys: trusted })).resolves.toMatchObject({ keyId: PRIMARY_ID });
      await writeFile(join(directory, INSTALLER), "tampered");
      await expect(verifyWindowsUpdateRelease(directory, { trustedPublicKeys: trusted })).rejects.toThrow("size does not match");
    } finally {
      await rm(keyPath, { force: true });
    }
  }));
});
