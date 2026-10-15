import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  WINDOWS_UPDATE_PUBLIC_KEYS,
  WINDOWS_UPDATE_SIGNATURE_NAME,
  verifyWindowsUpdateMetadata,
} from "../apps/desktop/src/main/windows-update-trust.mjs";
import { promptHidden } from "./fork-secret-prompt.mjs";

const normalizedPublicKey = (key) => (key?.type === "public" ? key : createPublicKey(key)).export({
  type: "spki",
  format: "pem",
}).trim();

const isEncryptedPem = (pem) => pem.includes("BEGIN ENCRYPTED PRIVATE KEY");

// Fork: the key must match one of the client's pinned keys (primary or cold
// backup). Its keyId is derived from the key itself, never taken on trust.
export const assertWindowsUpdateSigningKey = ({
  privateKeyPath,
  passphrase,
  trustedPublicKeys = WINDOWS_UPDATE_PUBLIC_KEYS,
}) => {
  if (!privateKeyPath) {
    throw new Error("EDGE_EVER_WINDOWS_UPDATE_SIGNING_KEY must point to the offline Ed25519 private key");
  }
  const pem = readFileSync(privateKeyPath, "utf8");
  if (isEncryptedPem(pem) && !passphrase) {
    throw new Error("The Windows update signing key is passphrase-protected; a passphrase is required");
  }
  let privateKey;
  try {
    privateKey = createPrivateKey(passphrase ? { key: pem, format: "pem", passphrase } : pem);
  } catch {
    throw new Error("Windows update signing key could not be decrypted (wrong passphrase or invalid key)");
  }
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("Windows update signing key must be Ed25519");
  }
  const derived = normalizedPublicKey(createPublicKey(privateKey));
  const keyId = Object.entries(trustedPublicKeys)
    .find(([, publicKey]) => normalizedPublicKey(publicKey) === derived)?.[0];
  if (!keyId) {
    throw new Error(Object.keys(trustedPublicKeys).length === 0
      ? "No Windows update public keys are pinned in the desktop client"
      : "Windows update signing key does not match the public key pinned in the desktop client");
  }
  return { privateKey, keyId };
};

export const signWindowsUpdateManifest = ({
  manifestPath,
  signaturePath,
  privateKeyPath,
  passphrase,
  trustedPublicKeys = WINDOWS_UPDATE_PUBLIC_KEYS,
}) => {
  const { privateKey, keyId } = assertWindowsUpdateSigningKey({ privateKeyPath, passphrase, trustedPublicKeys });
  const manifestBytes = readFileSync(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (manifest?.schemaVersion !== 1 || manifest.keyId !== keyId) {
    throw new Error(`Windows update manifest key metadata is invalid (manifest names ${manifest?.keyId}, the key is ${keyId})`);
  }
  const envelope = {
    schemaVersion: 1,
    keyId,
    signature: sign(null, manifestBytes, privateKey).toString("base64"),
  };
  const signatureBytes = Buffer.from(`${JSON.stringify(envelope)}\n`);
  // Verify exactly as a client would before writing anything.
  verifyWindowsUpdateMetadata({
    manifestBytes,
    signatureBytes,
    expectedVersion: manifest.version,
    updateInfo: {
      version: manifest.version,
      files: [{
        url: manifest.file?.name,
        size: manifest.file?.size,
        sha512: manifest.file?.sha512,
      }],
    },
    trustedPublicKeys,
  });
  writeFileSync(signaturePath, signatureBytes, { mode: 0o644 });
  return envelope;
};

const run = async () => {
  const [manifestValue, signatureValue] = process.argv.slice(2);
  if (!manifestValue) {
    throw new Error("Usage: node scripts/sign-windows-update-manifest.mjs <manifest> [signature]");
  }
  const manifestPath = resolve(manifestValue);
  const signaturePath = resolve(signatureValue || `${manifestPath}.sig`);
  if (!signaturePath.endsWith(WINDOWS_UPDATE_SIGNATURE_NAME)) {
    throw new Error(`Signature filename must end with ${WINDOWS_UPDATE_SIGNATURE_NAME}`);
  }
  const privateKeyPath = process.env.EDGE_EVER_WINDOWS_UPDATE_SIGNING_KEY;
  const passphrase = privateKeyPath && isEncryptedPem(readFileSync(privateKeyPath, "utf8"))
    ? await promptHidden("Windows update signing key passphrase: ")
    : undefined;
  const envelope = signWindowsUpdateManifest({ manifestPath, signaturePath, privateKeyPath, passphrase });
  process.stdout.write(`${signaturePath} (${envelope.keyId})\n`);
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await run();
}
