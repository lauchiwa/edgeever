import { createHash } from "node:crypto";
import { createReadStream, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FORK_RELEASE_CHANNEL } from "../apps/desktop/src/main/fork-config.mjs";
import {
  WINDOWS_UPDATE_KEY_ID,
  WINDOWS_UPDATE_MANIFEST_NAME,
  WINDOWS_UPDATE_PUBLIC_KEYS,
  WINDOWS_UPDATE_VERSION_PATTERN,
} from "../apps/desktop/src/main/windows-update-trust.mjs";

export const WINDOWS_UPDATE_CHANNEL_FILE = `${FORK_RELEASE_CHANNEL}.yml`;

const hashFile = (path, algorithm, encoding) => new Promise((resolveHash, rejectHash) => {
  const hash = createHash(algorithm);
  const stream = createReadStream(path);
  stream.on("error", rejectHash);
  stream.on("data", (chunk) => hash.update(chunk));
  stream.on("end", () => resolveHash(hash.digest(encoding)));
});

// keyId names the key that will sign this manifest: the primary by default,
// the cold backup only for an emergency key-rotation release.
export const createWindowsUpdateMetadata = async ({
  directory,
  version,
  keyId = WINDOWS_UPDATE_KEY_ID,
  trustedPublicKeys = WINDOWS_UPDATE_PUBLIC_KEYS,
}) => {
  if (!WINDOWS_UPDATE_VERSION_PATTERN.test(version)) {
    throw new Error(`Windows update version must be a fork release X.Y.Z-rc.N: ${version}`);
  }
  if (!Object.hasOwn(trustedPublicKeys, keyId)) {
    throw new Error(`Windows update key ${keyId} is not pinned in the desktop client`);
  }
  const installerName = `EdgeEver-${version}-windows-x64.exe`;
  const installerPath = join(directory, installerName);
  const stats = statSync(installerPath);
  if (!stats.isFile() || stats.size <= 0) {
    throw new Error(`Windows installer is missing or empty: ${installerPath}`);
  }
  const [sha512, sha256] = await Promise.all([
    hashFile(installerPath, "sha512", "base64"),
    hashFile(installerPath, "sha256", "hex"),
  ]);
  const releaseDate = new Date().toISOString();
  const manifest = {
    schemaVersion: 1,
    keyId,
    version,
    platform: "win32",
    arch: "x64",
    releaseDate,
    file: {
      name: installerName,
      size: stats.size,
      sha512,
      sha256,
    },
  };
  writeFileSync(
    join(directory, WINDOWS_UPDATE_MANIFEST_NAME),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  // A version with the "rc" pre-release id is fetched by electron-updater as
  // rc.yml (its channel), not latest.yml.
  writeFileSync(join(directory, WINDOWS_UPDATE_CHANNEL_FILE), [
    `version: ${version}`,
    "files:",
    `  - url: ${installerName}`,
    `    sha512: ${sha512}`,
    `    size: ${stats.size}`,
    `path: ${installerName}`,
    `sha512: ${sha512}`,
    `releaseDate: '${releaseDate}'`,
    "",
  ].join("\n"));
  writeFileSync(
    join(directory, "SHA256SUMS-windows.txt"),
    `${sha256}  ${installerName}\n`,
  );
  return manifest;
};

const run = async () => {
  const [directoryValue, version, keyId] = process.argv.slice(2);
  if (!directoryValue || !version) {
    throw new Error("Usage: node scripts/create-windows-update-metadata.mjs <directory> <version> [keyId]");
  }
  const directory = resolve(directoryValue);
  const packageVersion = JSON.parse(readFileSync("apps/desktop/package.json", "utf8")).version;
  if (version !== packageVersion) {
    throw new Error(`Requested version ${version} does not match desktop package version ${packageVersion}`);
  }
  const manifest = await createWindowsUpdateMetadata({ directory, version, ...(keyId ? { keyId } : {}) });
  process.stdout.write(`${basename(directory)}: ${manifest.file.name}\n`);
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await run();
}
