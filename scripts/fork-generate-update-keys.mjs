// Generates this fork's Windows update signing keys: a primary that signs
// releases and a cold backup that only signs a key-rotation release.
// Private keys are Ed25519, encrypted PKCS#8 PEM (AES-256-CBC, passphrase),
// written outside the repository, readable only by the current user, and
// never printed. Only the public keys are printed, for fork-config.mjs.
//
// Run interactively (PowerShell or Windows Terminal, not Git Bash):
//   node scripts/fork-generate-update-keys.mjs [outputDirectory]
import { execFileSync } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FORK_WINDOWS_UPDATE_KEYS } from "../apps/desktop/src/main/fork-config.mjs";
import { promptHidden } from "./fork-secret-prompt.mjs";

export const DEFAULT_KEY_DIRECTORY = join(homedir(), ".config", "edgeever-fork");
export const MIN_PASSPHRASE_LENGTH = 16;
export const KEY_FILES = Object.freeze({
  primary: "windows-update-ed25519-primary.pem",
  backup: "windows-update-ed25519-backup.pem",
  publicKeys: "windows-update-public-keys.json",
});

export const publicKeyFingerprint = (publicKey) => createHash("sha256")
  .update((publicKey?.type === "public" ? publicKey : createPublicKey(publicKey)).export({ type: "spki", format: "der" }))
  .digest("hex");

export const assertPassphrases = ({ primary, backup }) => {
  for (const [role, value] of Object.entries({ primary, backup })) {
    if (typeof value !== "string" || [...value].length < MIN_PASSPHRASE_LENGTH) {
      throw new Error(`The ${role} passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`);
    }
  }
  // Independent passphrases keep one leak from exposing both keys.
  if (primary === backup) throw new Error("The primary and backup passphrases must differ");
};

// Windows: drop inherited ACEs and grant only the current user. POSIX: 0600.
const restrictToCurrentUser = (path, platform) => {
  if (platform !== "win32") return { restricted: true };
  const user = process.env.USERDOMAIN && process.env.USERNAME
    ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}`
    : process.env.USERNAME;
  if (!user) return { restricted: false };
  try {
    execFileSync("icacls", [path, "/inheritance:r", "/grant:r", `${user}:F`], { stdio: "ignore", windowsHide: true });
    return { restricted: true };
  } catch {
    return { restricted: false };
  }
};

export const generateForkUpdateKeys = ({
  directory = DEFAULT_KEY_DIRECTORY,
  passphrases,
  platform = process.platform,
  now = new Date(),
}) => {
  assertPassphrases(passphrases);
  const roles = ["primary", "backup"];
  const paths = Object.fromEntries([...roles, "publicKeys"].map((role) => [role, join(directory, KEY_FILES[role])]));
  const existing = Object.values(paths).filter((path) => existsSync(path));
  if (existing.length) {
    // Overwriting a signing key would orphan every client that pins it.
    throw new Error(`Refusing to overwrite existing key files: ${existing.join(", ")}`);
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });

  const written = [];
  try {
    const bundle = { generatedAt: now.toISOString(), algorithm: "ed25519", keys: {} };
    for (const role of roles) {
      const { privateKey, publicKey } = generateKeyPairSync("ed25519");
      const encryptedPem = privateKey.export({
        type: "pkcs8",
        format: "pem",
        cipher: "aes-256-cbc",
        passphrase: passphrases[role],
      });
      // Self-test before anything relies on the file.
      const reloaded = createPrivateKey({ key: encryptedPem, format: "pem", passphrase: passphrases[role] });
      const probe = randomBytes(32);
      if (!verify(null, probe, publicKey, sign(null, probe, reloaded))) {
        throw new Error(`The ${role} key failed its sign/verify self-test`);
      }
      let wrongPassphraseRejected = false;
      try { createPrivateKey({ key: encryptedPem, format: "pem", passphrase: `${passphrases[role]}x` }); }
      catch { wrongPassphraseRejected = true; }
      if (!wrongPassphraseRejected || !encryptedPem.includes("BEGIN ENCRYPTED PRIVATE KEY")) {
        throw new Error(`The ${role} key is not passphrase-protected`);
      }
      writeFileSync(paths[role], encryptedPem, { flag: "wx", mode: 0o600 });
      written.push(paths[role]);
      const { restricted } = restrictToCurrentUser(paths[role], platform);
      bundle.keys[role] = {
        keyId: FORK_WINDOWS_UPDATE_KEYS[role].keyId,
        publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).trim(),
        fingerprintSha256: publicKeyFingerprint(publicKey),
        privateKeyFile: paths[role],
        aclRestricted: restricted,
      };
    }
    writeFileSync(paths.publicKeys, `${JSON.stringify(bundle, null, 2)}\n`, { flag: "wx", mode: 0o644 });
    written.push(paths.publicKeys);
    return bundle;
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

const run = async () => {
  const directory = resolve(process.argv[2] || DEFAULT_KEY_DIRECTORY);
  process.stderr.write([
    `Keys will be written to ${directory}`,
    `Use two different passphrases, each at least ${MIN_PASSPHRASE_LENGTH} characters.`,
    "Store both passphrases in your password manager before continuing.",
    "",
  ].join("\n"));
  const primary = await askTwice("Primary key passphrase");
  const backup = await askTwice("Backup key passphrase");
  const bundle = generateForkUpdateKeys({ directory, passphrases: { primary, backup } });
  process.stdout.write(`${JSON.stringify({
    publicKeys: Object.fromEntries(Object.entries(bundle.keys).map(([role, key]) => [role, {
      keyId: key.keyId,
      fingerprintSha256: key.fingerprintSha256,
      publicKeyPem: key.publicKeyPem,
    }])),
    publicKeysFile: join(directory, KEY_FILES.publicKeys),
    privateKeysRestrictedToCurrentUser: Object.values(bundle.keys).every((key) => key.aclRestricted),
  }, null, 2)}\n`);
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await run();
}
