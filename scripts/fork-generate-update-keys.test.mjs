import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { FORK_WINDOWS_UPDATE_KEYS } from "../apps/desktop/src/main/fork-config.mjs";
import { KEY_FILES, generateForkUpdateKeys, publicKeyFingerprint } from "./fork-generate-update-keys.mjs";

const passphrases = { primary: "primary passphrase 0001", backup: "backup passphrase 0002" };

const withDirectory = async (run) => {
  const directory = await mkdtemp(join(tmpdir(), "edgeever-fork-keys-"));
  try { return await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
};

describe("fork update key generation", () => {
  test("writes two independent, passphrase-encrypted Ed25519 keys and a public bundle", () => withDirectory((directory) => {
    const bundle = generateForkUpdateKeys({ directory, passphrases, platform: "linux" });
    expect(Object.keys(bundle.keys)).toEqual(["primary", "backup"]);
    for (const role of ["primary", "backup"]) {
      const key = bundle.keys[role];
      expect(key.keyId).toBe(FORK_WINDOWS_UPDATE_KEYS[role].keyId);
      const pem = readFileSync(join(directory, KEY_FILES[role]), "utf8");
      expect(pem).toContain("BEGIN ENCRYPTED PRIVATE KEY");
      expect(pem).not.toContain("BEGIN PRIVATE KEY");
      expect(() => createPrivateKey(pem)).toThrow();
      expect(() => createPrivateKey({ key: pem, format: "pem", passphrase: passphrases[role === "primary" ? "backup" : "primary"] })).toThrow();
      const privateKey = createPrivateKey({ key: pem, format: "pem", passphrase: passphrases[role] });
      const publicKey = createPublicKey(key.publicKeyPem);
      expect(verify(null, Buffer.from("probe"), publicKey, sign(null, Buffer.from("probe"), privateKey))).toBe(true);
      expect(key.fingerprintSha256).toBe(publicKeyFingerprint(publicKey));
    }
    expect(bundle.keys.primary.publicKeyPem).not.toBe(bundle.keys.backup.publicKeyPem);
    const saved = JSON.parse(readFileSync(join(directory, KEY_FILES.publicKeys), "utf8"));
    expect(JSON.stringify(saved)).not.toContain("PRIVATE KEY");
    expect(saved.keys.primary.publicKeyPem).toBe(bundle.keys.primary.publicKeyPem);
  }));

  test("rejects short, missing or identical passphrases before writing anything", () => withDirectory((directory) => {
    for (const bad of [
      { primary: "short", backup: passphrases.backup },
      { primary: passphrases.primary, backup: undefined },
      { primary: passphrases.primary, backup: passphrases.primary },
    ]) {
      expect(() => generateForkUpdateKeys({ directory, passphrases: bad, platform: "linux" })).toThrow();
    }
    for (const name of Object.values(KEY_FILES)) expect(existsSync(join(directory, name))).toBe(false);
  }));

  test("never overwrites an existing key and leaves it untouched", () => withDirectory(async (directory) => {
    const existing = join(directory, KEY_FILES.backup);
    await writeFile(existing, "pre-existing key");
    expect(() => generateForkUpdateKeys({ directory, passphrases, platform: "linux" })).toThrow("Refusing to overwrite");
    expect(readFileSync(existing, "utf8")).toBe("pre-existing key");
    expect(existsSync(join(directory, KEY_FILES.primary))).toBe(false);
  }));
});
