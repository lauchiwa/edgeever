import { X509Certificate, createPrivateKey, createPublicKey } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { MAC_KEY_FILES, assertCodeSigningCertificate, generateMacSigningCertificates, parseGenerateArguments } from "./fork-generate-macos-signing-certificates.mjs";
import { DEFAULT_KEY_DIRECTORY } from "./fork-generate-update-keys.mjs";
import { macCertificateSha1, pinnedMacCertificates } from "./fork-macos-release.mjs";

const passphrases = { primary: "primary passphrase 0001", backup: "backup passphrase 0002" };
// codesign exists only on macOS; the self-test runs on every real generation.
const options = { passphrases, platform: "linux", selfTest: false };

const withDirectory = async (run) => {
  const directory = await mkdtemp(join(tmpdir(), "edgeever-fork-macos-keys-"));
  try { return await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
};

describe("fork macOS signing certificate generation", () => {
  test("writes two encrypted RSA-3072 keys and self-signed code-signing certificates", () => withDirectory((directory) => {
    const now = new Date("2026-05-01T00:00:00.000Z");
    const bundle = generateMacSigningCertificates({ ...options, directory, now });
    expect(Object.keys(bundle.certificates)).toEqual(["primary", "backup"]);
    for (const role of ["primary", "backup"]) {
      const entry = bundle.certificates[role];
      const certificate = assertCodeSigningCertificate(entry.certificatePem);
      expect(certificate.ca).toBe(false);
      expect(certificate.keyUsage).toEqual(["1.3.6.1.5.5.7.3.3"]);
      expect(certificate.subject).toBe(`CN=EdgeEver Fork Code Signing (lauchiwa) ${role}`);
      expect(certificate.publicKey.asymmetricKeyDetails.modulusLength).toBe(3072);
      expect(new Date(certificate.validTo).getUTCFullYear()).toBe(2046);
      expect(new Date(certificate.validFrom) <= now).toBe(true);
      expect(entry.sha1).toBe(macCertificateSha1(entry.certificatePem));
      expect(entry.sha256).toBe(certificate.fingerprint256.replaceAll(":", "").toLowerCase());
      const pem = readFileSync(join(directory, MAC_KEY_FILES[role]), "utf8");
      expect(pem).toContain("BEGIN ENCRYPTED PRIVATE KEY");
      expect(() => createPrivateKey(pem)).toThrow();
      const privateKey = createPrivateKey({ key: pem, format: "pem", passphrase: passphrases[role] });
      expect(createPublicKey(privateKey).equals(new X509Certificate(entry.certificatePem).publicKey)).toBe(true);
    }
    // The pair is usable as fork-config.mjs pins.
    expect(() => pinnedMacCertificates(bundle.certificates)).not.toThrow();
    const saved = readFileSync(join(directory, MAC_KEY_FILES.certificates), "utf8");
    expect(saved).not.toContain("PRIVATE KEY");
    expect(JSON.parse(saved).certificates.primary.certificatePem).toBe(bundle.certificates.primary.certificatePem);
    expect(bundle.selfTested).toBe(false);
  }));

  test("rejects weak or identical passphrases before writing anything", () => withDirectory((directory) => {
    expect(() => generateMacSigningCertificates({ ...options, directory, passphrases: { primary: "short", backup: passphrases.backup } })).toThrow();
    expect(() => generateMacSigningCertificates({ ...options, directory, passphrases: { primary: passphrases.primary, backup: passphrases.primary } })).toThrow();
    for (const name of Object.values(MAC_KEY_FILES)) expect(existsSync(join(directory, name))).toBe(false);
  }));

  test("never overwrites existing keys", () => withDirectory(async (directory) => {
    await writeFile(join(directory, MAC_KEY_FILES.backup), "existing");
    expect(() => generateMacSigningCertificates({ ...options, directory })).toThrow("Refusing to overwrite");
    expect(readFileSync(join(directory, MAC_KEY_FILES.backup), "utf8")).toBe("existing");
    expect(existsSync(join(directory, MAC_KEY_FILES.primary))).toBe(false);
  }));

  test("skips the codesign self-test only off a Mac and only when asked", () => {
    expect(() => parseGenerateArguments([], "win32")).toThrow("--skip-self-test");
    expect(parseGenerateArguments(["--skip-self-test"], "win32")).toEqual({ directory: resolve(DEFAULT_KEY_DIRECTORY), selfTest: false });
    expect(parseGenerateArguments(["--skip-self-test", "keys"], "linux")).toEqual({ directory: resolve("keys"), selfTest: false });
    expect(parseGenerateArguments(["--skip-self-test"], "darwin").selfTest).toBe(true);
    expect(parseGenerateArguments(["keys"], "darwin")).toEqual({ directory: resolve("keys"), selfTest: true });
    expect(() => parseGenerateArguments(["--skip-selftest"], "win32")).toThrow("Unknown option");
    expect(() => parseGenerateArguments(["--skip-self-test", "a", "b"], "win32")).toThrow("at most one");
  });
});
