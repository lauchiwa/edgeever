import { createHash, createPublicKey, verify } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import {
  FORK_RELEASES_URL,
  FORK_VERSION_PATTERN,
  FORK_WINDOWS_UPDATE_KEYS,
  forkTrustedWindowsUpdateKeys,
} from "./fork-config.mjs";

// Fork: trust only this fork's offline keys (primary + cold backup), never
// upstream's, and only fork versions (X.Y.Z-rc.N). See fork-config.mjs.
export const WINDOWS_UPDATE_KEY_ID = FORK_WINDOWS_UPDATE_KEYS.primary.keyId;
export const WINDOWS_UPDATE_MANIFEST_NAME = "latest-windows.json";
export const WINDOWS_UPDATE_SIGNATURE_NAME = `${WINDOWS_UPDATE_MANIFEST_NAME}.sig`;
export const WINDOWS_UPDATE_PUBLIC_KEYS = forkTrustedWindowsUpdateKeys();
export const WINDOWS_UPDATE_VERSION_PATTERN = FORK_VERSION_PATTERN;

const MAX_METADATA_BYTES = 64 * 1024;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const SHA512_BASE64 = /^[A-Za-z0-9+/]{86}==$/;

const releaseAssetUrl = (version, name) => {
  if (!FORK_VERSION_PATTERN.test(version)) {
    throw new Error(`Windows update version must be a fork release X.Y.Z-rc.N: ${version}`);
  }
  return `${FORK_RELEASES_URL}/download/v${version}/${name}`;
};

const responseBytes = async (response, label) => {
  if (!response?.ok) {
    throw new Error(`${label} request failed with HTTP ${response?.status ?? "unknown"}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_METADATA_BYTES) {
    throw new Error(`${label} has an invalid size`);
  }
  return bytes;
};

const parseJson = (bytes, label) => {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
};

const updateFileName = (value) => {
  const withoutQuery = String(value ?? "").split(/[?#]/, 1)[0];
  try {
    return basename(decodeURIComponent(withoutQuery));
  } catch {
    return "";
  }
};

const assertManifestShape = (manifest, expectedVersion, signingKeyId) => {
  if (
    manifest?.schemaVersion !== 1 ||
    manifest.keyId !== signingKeyId ||
    typeof expectedVersion !== "string" ||
    !FORK_VERSION_PATTERN.test(expectedVersion) ||
    manifest.version !== expectedVersion ||
    manifest.platform !== "win32" ||
    manifest.arch !== "x64" ||
    typeof manifest.releaseDate !== "string" ||
    Number.isNaN(Date.parse(manifest.releaseDate)) ||
    typeof manifest.file?.name !== "string" ||
    !/^EdgeEver-[0-9A-Za-z.-]+-windows-x64\.exe$/.test(manifest.file.name) ||
    typeof manifest.file.size !== "number" ||
    !Number.isSafeInteger(manifest.file.size) ||
    manifest.file.size <= 0 ||
    typeof manifest.file.sha512 !== "string" ||
    !SHA512_BASE64.test(manifest.file.sha512) ||
    typeof manifest.file.sha256 !== "string" ||
    !SHA256_HEX.test(manifest.file.sha256)
  ) {
    throw new Error("Windows update manifest fields are invalid");
  }
  if (manifest.file.name !== `EdgeEver-${expectedVersion}-windows-x64.exe`) {
    throw new Error("Windows update manifest filename does not match its version");
  }
};

const assertUpdateInfoMatches = (manifest, updateInfo) => {
  const files = updateInfo?.files ?? [];
  const matchingFiles = files.filter(
    (file) => updateFileName(file?.url) === manifest.file.name,
  );
  if (files.length !== 1 || matchingFiles.length !== 1) {
    throw new Error("Electron update metadata does not contain exactly one trusted installer");
  }
  const [file] = matchingFiles;
  if (file.sha512 !== manifest.file.sha512 || file.size !== manifest.file.size) {
    throw new Error("Electron update metadata does not match the signed manifest");
  }
};

export const verifyWindowsUpdateMetadata = ({
  manifestBytes,
  signatureBytes,
  expectedVersion,
  updateInfo,
  trustedPublicKeys = WINDOWS_UPDATE_PUBLIC_KEYS,
}) => {
  const signatureEnvelope = parseJson(signatureBytes, "Windows update signature");
  if (
    signatureEnvelope?.schemaVersion !== 1 ||
    typeof signatureEnvelope.keyId !== "string" ||
    !Object.hasOwn(trustedPublicKeys, signatureEnvelope.keyId) ||
    typeof signatureEnvelope.signature !== "string"
  ) {
    throw new Error(Object.keys(trustedPublicKeys).length === 0
      ? "Windows update trust keys are not configured"
      : "Windows update signature fields are invalid");
  }
  const signature = Buffer.from(signatureEnvelope.signature, "base64");
  if (signature.byteLength !== 64) {
    throw new Error("Windows update signature has an invalid length");
  }
  const publicKey = trustedPublicKeys[signatureEnvelope.keyId];
  const verificationKey = publicKey?.type === "public" ? publicKey : publicKey ? createPublicKey(publicKey) : null;
  if (!verificationKey || !verify(null, manifestBytes, verificationKey, signature)) {
    throw new Error("Windows update manifest signature is invalid");
  }

  const manifest = parseJson(manifestBytes, "Windows update manifest");
  assertManifestShape(manifest, expectedVersion, signatureEnvelope.keyId);
  assertUpdateInfoMatches(manifest, updateInfo);
  return manifest;
};

export const fetchTrustedWindowsUpdate = async ({
  version,
  updateInfo,
  fetchImpl,
}) => {
  const request = (name) => fetchImpl(releaseAssetUrl(version, name), {
    cache: "no-store",
    redirect: "follow",
  });
  const [manifestResponse, signatureResponse] = await Promise.all([
    request(WINDOWS_UPDATE_MANIFEST_NAME),
    request(WINDOWS_UPDATE_SIGNATURE_NAME),
  ]);
  const [manifestBytes, signatureBytes] = await Promise.all([
    responseBytes(manifestResponse, "Windows update manifest"),
    responseBytes(signatureResponse, "Windows update signature"),
  ]);
  return verifyWindowsUpdateMetadata({
    manifestBytes,
    signatureBytes,
    expectedVersion: version,
    updateInfo,
  });
};

const hashFile = (path, algorithm, encoding) => new Promise((resolve, reject) => {
  const hash = createHash(algorithm);
  const stream = createReadStream(path);
  stream.on("error", reject);
  stream.on("data", (chunk) => hash.update(chunk));
  stream.on("end", () => resolve(hash.digest(encoding)));
});

export const verifyDownloadedWindowsUpdate = async ({ path, manifest }) => {
  const fileStat = await stat(path);
  if (!fileStat.isFile() || fileStat.size !== manifest.file.size) {
    throw new Error("Downloaded Windows installer size does not match the signed manifest");
  }
  const [sha512, sha256] = await Promise.all([
    hashFile(path, "sha512", "base64"),
    hashFile(path, "sha256", "hex"),
  ]);
  if (sha512 !== manifest.file.sha512 || sha256 !== manifest.file.sha256) {
    throw new Error("Downloaded Windows installer checksum does not match the signed manifest");
  }
  return true;
};
