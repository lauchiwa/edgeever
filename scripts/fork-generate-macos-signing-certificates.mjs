// Generates this fork's macOS code-signing identities: a primary that signs
// releases (its key goes to the fork-macos Environment) and a cold backup that
// only signs a rotation release if the primary is lost or leaked. Each is an
// RSA-3072 key, encrypted PKCS#8 PEM (AES-256-CBC, passphrase), written
// outside the repository and readable only by the current user, plus a
// self-signed code-signing certificate valid for 20 years. Only the
// certificates are printed, for fork-config.mjs.
//
// Run interactively from the repository, on a Mac (Terminal):
//   node scripts/fork-generate-macos-signing-certificates.mjs [outputDirectory]
// or elsewhere (PowerShell or Windows Terminal), without the self-test:
//   node scripts/fork-generate-macos-signing-certificates.mjs --skip-self-test [outputDirectory]
//
// On a Mac, before writing anything it signs a test binary with each identity
// in a throwaway keychain and checks it against the requirement releases carry,
// exactly as the macos-sign job will. Without it the primary is still checked
// by the macos-sign and macos-verify jobs before a release is published; the
// backup is not exercised until it signs a rotation release.
import { spawnSync } from "node:child_process";
import { X509Certificate, createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FORK_MACOS_BUNDLE_ID } from "../apps/desktop/src/main/fork-config.mjs";
import { DEFAULT_KEY_DIRECTORY, assertPassphrases } from "./fork-generate-update-keys.mjs";
import { macCertificateSha1, macDesignatedRequirement, withMacSigningKeychain } from "./fork-macos-release.mjs";
import { promptHidden } from "./fork-secret-prompt.mjs";

export const MAC_KEY_FILES = Object.freeze({
  primary: "macos-signing-rsa-primary.pem",
  backup: "macos-signing-rsa-backup.pem",
  certificates: "macos-signing-certificates.json",
});
export const CERTIFICATE_YEARS = 20;
const commonName = (role) => `EdgeEver Fork Code Signing (lauchiwa) ${role}`;

// --- Minimal DER, enough for one X.509 v3 certificate ------------------------

const der = (tag, ...parts) => {
  const body = Buffer.concat(parts);
  const length = body.length < 0x80 ? Buffer.from([body.length]) : (() => {
    const bytes = [];
    for (let value = body.length; value > 0; value = Math.floor(value / 256)) bytes.unshift(value & 0xff);
    return Buffer.from([0x80 | bytes.length, ...bytes]);
  })();
  return Buffer.concat([Buffer.from([tag]), length, body]);
};
const sequence = (...parts) => der(0x30, ...parts);
const set = (...parts) => der(0x31, ...parts);
const octets = (bytes) => der(0x04, bytes);
const bits = (bytes) => der(0x03, Buffer.from([0]), bytes);
const integer = (bytes) => der(0x02, bytes[0] & 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes);
const boolean = (value) => der(0x01, Buffer.from([value ? 0xff : 0]));
const oid = (dotted) => {
  const [first, second, ...rest] = dotted.split(".").map(Number);
  const encode = (value) => {
    const bytes = [value & 0x7f];
    for (value = Math.floor(value / 128); value > 0; value = Math.floor(value / 128)) bytes.unshift(0x80 | (value & 0x7f));
    return bytes;
  };
  return der(0x06, Buffer.from([40 * first + second, ...rest.flatMap(encode)]));
};
const utf8 = (text) => der(0x0c, Buffer.from(text, "utf8"));
// UTCTime through 2049, GeneralizedTime after (RFC 5280).
const time = (date) => {
  const iso = date.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return date.getUTCFullYear() < 2050 ? der(0x17, Buffer.from(`${iso.slice(2)}Z`)) : der(0x18, Buffer.from(`${iso}Z`));
};
const extension = (id, critical, value) => sequence(oid(id), ...(critical ? [boolean(true)] : []), octets(value));
const SHA256_WITH_RSA = sequence(oid("1.2.840.113549.1.1.11"), der(0x05));
// A self-signed X.509 v3 code-signing certificate: not a CA, digitalSignature
// only, extended key usage codeSigning, all critical, SHA-256 with RSA.
export const buildCodeSigningCertificate = ({ privateKey, publicKey, role, now = new Date(), years = CERTIFICATE_YEARS }) => {
  const notBefore = new Date(now.getTime() - 60 * 60 * 1000);
  const notAfter = new Date(now);
  notAfter.setUTCFullYear(notAfter.getUTCFullYear() + years);
  const serial = randomBytes(16);
  // Positive and without a leading zero byte: DER requires the minimal
  // encoding, and a 0x00 first byte before one below 0x80 is rejected.
  serial[0] = (serial[0] & 0x7f) | 0x40;
  const name = sequence(set(sequence(oid("2.5.4.3"), utf8(commonName(role)))));
  const spki = publicKey.export({ type: "spki", format: "der" });
  const tbs = sequence(
    der(0xa0, integer(Buffer.from([2]))),
    integer(serial),
    SHA256_WITH_RSA,
    name,
    sequence(time(notBefore), time(notAfter)),
    name,
    spki,
    der(0xa3, sequence(
      extension("2.5.29.19", true, sequence()),
      extension("2.5.29.15", true, bits(Buffer.from([0x80]))),
      extension("2.5.29.37", true, sequence(oid("1.3.6.1.5.5.7.3.3"))),
      extension("2.5.29.14", false, octets(createHash("sha1").update(spki).digest())),
    )),
  );
  const certificate = sequence(tbs, SHA256_WITH_RSA, bits(sign("sha256", tbs, privateKey)));
  const base64 = certificate.toString("base64").match(/.{1,64}/g).join("\n");
  return `-----BEGIN CERTIFICATE-----\n${base64}\n-----END CERTIFICATE-----`;
};

const CODE_SIGNING_EKU = "1.3.6.1.5.5.7.3.3";
export const assertCodeSigningCertificate = (pem) => {
  const certificate = new X509Certificate(pem);
  // Not checkIssued: OpenSSL wants keyCertSign on an issuer, which an end-entity
  // signing certificate must not have.
  if (certificate.ca || certificate.subject !== certificate.issuer || !certificate.verify(certificate.publicKey)) {
    throw new Error("Not a self-signed end-entity certificate");
  }
  if (!certificate.keyUsage?.includes(CODE_SIGNING_EKU)) throw new Error("The certificate is not for code signing");
  if (certificate.publicKey.asymmetricKeyType !== "rsa" || certificate.publicKey.asymmetricKeyDetails.modulusLength < 3072) {
    throw new Error("The certificate key must be RSA-3072 or larger");
  }
  return certificate;
};

const run = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error || result.status !== 0) throw new Error(`${command} ${args[0]} failed: ${(result.stderr || result.error?.message || "").trim()}`);
};

// Signs a copy of /usr/bin/true with each identity and checks it against the
// requirement fork releases carry, through the same keychain code CI uses.
export const selfTestMacSigning = (identities) => {
  const certificates = {
    primary: { certificatePem: identities.primary.certificatePem },
    backup: { certificatePem: identities.backup.certificatePem },
  };
  const requirement = macDesignatedRequirement(certificates);
  const directory = mkdtempSync(join(tmpdir(), "edgeever-fork-macos-selftest-"));
  try {
    for (const role of ["primary", "backup"]) {
      const binary = join(directory, role);
      copyFileSync("/usr/bin/true", binary);
      withMacSigningKeychain(identities[role], (identity, keychain) => run("codesign", [
        "--force", "--sign", identity, "--keychain", keychain, "--timestamp=none", "--identifier", FORK_MACOS_BUNDLE_ID, binary,
      ]));
      run("codesign", ["--verify", "--strict", "-R", `=${requirement}`, binary]);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

export const generateMacSigningCertificates = ({
  directory = DEFAULT_KEY_DIRECTORY,
  passphrases,
  now = new Date(),
  platform = process.platform,
  // Tests on other platforms skip it; a real run never does.
  selfTest = platform === "darwin",
}) => {
  assertPassphrases(passphrases);
  const roles = ["primary", "backup"];
  const paths = Object.fromEntries([...roles, "certificates"].map((role) => [role, join(directory, MAC_KEY_FILES[role])]));
  const existing = Object.values(paths).filter((path) => existsSync(path));
  if (existing.length) {
    // Replacing both certificates would orphan every installed macOS client.
    throw new Error(`Refusing to overwrite existing key files: ${existing.join(", ")}`);
  }

  const identities = {};
  const encrypted = {};
  for (const role of roles) {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
    const certificatePem = buildCodeSigningCertificate({ privateKey, publicKey, role, now });
    assertCodeSigningCertificate(certificatePem);
    encrypted[role] = privateKey.export({ type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase: passphrases[role] });
    const reloaded = createPrivateKey({ key: encrypted[role], format: "pem", passphrase: passphrases[role] });
    if (!new X509Certificate(certificatePem).publicKey.equals(createPublicKey(reloaded))) {
      throw new Error(`The ${role} key does not reload to its certificate`);
    }
    let wrongPassphraseRejected = false;
    try { createPrivateKey({ key: encrypted[role], format: "pem", passphrase: `${passphrases[role]}x` }); }
    catch { wrongPassphraseRejected = true; }
    if (!wrongPassphraseRejected || !encrypted[role].includes("BEGIN ENCRYPTED PRIVATE KEY")) {
      throw new Error(`The ${role} key is not passphrase-protected`);
    }
    identities[role] = { privateKey: reloaded, certificatePem };
  }
  if (selfTest) selfTestMacSigning(identities);

  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const written = [];
  try {
    const bundle = { generatedAt: now.toISOString(), algorithm: "rsa-3072", certificates: {} };
    for (const role of roles) {
      writeFileSync(paths[role], encrypted[role], { flag: "wx", mode: 0o600 });
      written.push(paths[role]);
      const { certificatePem } = identities[role];
      const certificate = new X509Certificate(certificatePem);
      bundle.certificates[role] = {
        certificatePem,
        sha1: macCertificateSha1(certificatePem),
        sha256: certificate.fingerprint256.replaceAll(":", "").toLowerCase(),
        notAfter: new Date(certificate.validTo).toISOString(),
        privateKeyFile: paths[role],
      };
    }
    writeFileSync(paths.certificates, `${JSON.stringify(bundle, null, 2)}\n`, { flag: "wx", mode: 0o644 });
    written.push(paths.certificates);
    return { ...bundle, selfTested: selfTest };
  } catch (error) {
    // Remove only what this run created; never touch pre-existing files.
    for (const path of written) rmSync(path, { force: true });
    throw error;
  }
};

const askTwice = async (label) => {
  const first = await promptHidden(`${label}: `);
  const second = await promptHidden(`${label} (again): `);
  if (first !== second) throw new Error(`${label}: the two entries do not match`);
  return first;
};

export const SKIP_SELF_TEST_FLAG = "--skip-self-test";

export const parseGenerateArguments = (argv, platform = process.platform) => {
  const flags = argv.filter((arg) => arg.startsWith("-"));
  const positional = argv.filter((arg) => !arg.startsWith("-"));
  const unknown = flags.filter((flag) => flag !== SKIP_SELF_TEST_FLAG);
  if (unknown.length) throw new Error(`Unknown option: ${unknown.join(", ")}`);
  if (positional.length > 1) throw new Error("Expected at most one output directory");
  const skipSelfTest = flags.includes(SKIP_SELF_TEST_FLAG);
  if (platform !== "darwin" && !skipSelfTest) {
    throw new Error(`The codesign self-test needs a Mac; elsewhere pass ${SKIP_SELF_TEST_FLAG} explicitly`);
  }
  // codesign is always available on a Mac, so the self-test never skips there.
  return { directory: resolve(positional[0] || DEFAULT_KEY_DIRECTORY), selfTest: platform === "darwin" };
};

const main = async () => {
  const { directory, selfTest } = parseGenerateArguments(process.argv.slice(2));
  process.stderr.write([
    `Keys will be written to ${directory}`,
    ...(selfTest ? [] : [
      "Skipping the codesign self-test: the macos-sign and macos-verify jobs check the primary before any release; the backup stays untested until a Mac is available.",
    ]),
    "Use two different passphrases, each at least 16 characters, distinct from the Windows update key passphrases.",
    "Store both passphrases in your password manager before continuing.",
    "",
  ].join("\n"));
  const primary = await askTwice("Primary macOS signing key passphrase");
  const backup = await askTwice("Backup macOS signing key passphrase");
  const bundle = generateMacSigningCertificates({ directory, passphrases: { primary, backup }, selfTest });
  process.stdout.write(`${JSON.stringify({
    certificates: Object.fromEntries(Object.entries(bundle.certificates).map(([role, entry]) => [role, {
      sha1: entry.sha1,
      sha256: entry.sha256,
      notAfter: entry.notAfter,
      certificatePem: entry.certificatePem,
    }])),
    certificatesFile: join(directory, MAC_KEY_FILES.certificates),
    selfTested: bundle.selfTested,
  }, null, 2)}\n`);
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
