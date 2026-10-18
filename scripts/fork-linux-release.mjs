// Linux x64 assets of a fork release (see docs/fork-releases.md).
//
//   node scripts/fork-linux-release.mjs stage <release/desktop> <stage> <X.Y.Z-rc.N>
//   node scripts/fork-linux-release.mjs verify <directory> <X.Y.Z-rc.N>
//
// electron-builder writes latest-linux.yml, but an installed rc client asks
// GitHub for rc-linux.yml (its channel), exactly like rc.yml on Windows. The
// AppImage is trusted like upstream's Linux Preview: HTTPS from this fork's
// Releases, the sha512 in rc-linux.yml checked by electron-updater, and an
// independent SHA256SUMS-linux.txt. There is no signed manifest on Linux.
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FORK_RELEASE_CHANNEL, FORK_VERSION_PATTERN } from "../apps/desktop/src/main/fork-config.mjs";

export const LINUX_UPDATE_CHANNEL_FILE = `${FORK_RELEASE_CHANNEL}-linux.yml`;
export const LINUX_CHECKSUM_FILE = "SHA256SUMS-linux.txt";
export const linuxAppImageName = (version) => `EdgeEver-${version}-linux-x64.AppImage`;
export const linuxReleaseAssetNames = (version) => [linuxAppImageName(version), LINUX_UPDATE_CHANNEL_FILE, LINUX_CHECKSUM_FILE];

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const hashFile = (path, algorithm, encoding) => createHash(algorithm).update(readFileSync(path)).digest(encoding);
const count = (text, pattern) => (text.match(pattern) || []).length;

const assertForkVersion = (version) => {
  if (!FORK_VERSION_PATTERN.test(version ?? "")) throw new Error(`Linux release version must be a fork release X.Y.Z-rc.N: ${version}`);
};

// The update metadata must select exactly this AppImage, by name, digest and
// size, and carry the block map that electron-builder embeds in the AppImage.
export const verifyLinuxUpdateMetadata = ({ metadata, version, appImagePath }) => {
  const name = linuxAppImageName(version);
  const size = statSync(appImagePath).size;
  if (size <= 0) throw new Error(`Linux AppImage is empty: ${appImagePath}`);
  const sha512 = hashFile(appImagePath, "sha512", "base64");
  // Only the lines electron-builder writes for one AppImage; anything else
  // (another key, a stray line) could change what the updater reads.
  const known = /^(?:version: \S+|files:| {2}- url: \S+| {4}sha512: \S+| {4}size: \d+| {4}blockMapSize: \d+|path: \S+|sha512: \S+|releaseDate: '[^']+')$/;
  const lines = metadata.split("\n");
  if (lines.pop() !== "" || lines.some((line) => !known.test(line))) {
    throw new Error("Linux update metadata has unexpected content");
  }
  if (count(metadata, /^version:/gm) !== 1 || !new RegExp(`^version: ${escapeRegExp(version)}$`, "m").test(metadata)) {
    throw new Error(`Linux update metadata is not version ${version}`);
  }
  const urls = [...metadata.matchAll(/^ {2}- url:\s*(.+?)\s*$/gm)].map((match) => match[1]);
  if (urls.length !== 1 || urls[0] !== name) throw new Error(`Linux update metadata must select exactly ${name}`);
  const entry = new RegExp(`^ {2}- url: ${escapeRegExp(name)}\\n {4}sha512: ${escapeRegExp(sha512)}\\n {4}size: ${size}\\n {4}blockMapSize: [1-9]\\d*$`, "m");
  if (!entry.test(metadata)) throw new Error("Linux update metadata does not match the AppImage digest, size and block map");
  if (count(metadata, /^path:/gm) !== 1 || !new RegExp(`^path: ${escapeRegExp(name)}$`, "m").test(metadata)) {
    throw new Error("Linux update metadata path does not select the AppImage");
  }
  if (count(metadata, /^sha512:/gm) !== 1 || !new RegExp(`^sha512: ${escapeRegExp(sha512)}$`, "m").test(metadata)) {
    throw new Error("Linux update metadata top-level digest does not match the AppImage");
  }
  return { name, size, sha512 };
};

// Checks a directory holding exactly the three Linux assets, as staged by CI
// or as downloaded again from GitHub before publishing.
export const verifyLinuxRelease = (directory, version) => {
  assertForkVersion(version);
  const expected = [...linuxReleaseAssetNames(version)].sort();
  const actual = readdirSync(directory).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Linux release must contain exactly ${expected.join(", ")}; found ${actual.join(", ") || "nothing"}`);
  }
  const appImagePath = join(directory, linuxAppImageName(version));
  const metadata = readFileSync(join(directory, LINUX_UPDATE_CHANNEL_FILE), "utf8");
  const { name, size, sha512 } = verifyLinuxUpdateMetadata({ metadata, version, appImagePath });
  const sha256 = hashFile(appImagePath, "sha256", "hex");
  if (readFileSync(join(directory, LINUX_CHECKSUM_FILE), "utf8") !== `${sha256}  ${name}\n`) {
    throw new Error(`${LINUX_CHECKSUM_FILE} does not exactly match the AppImage`);
  }
  return { version, file: { name, size, sha512, sha256 } };
};

// Copies the AppImage and electron-builder's latest-linux.yml (renamed to the
// rc channel file, bytes unchanged) into stage, and writes the checksum list.
export const stageLinuxRelease = ({ buildDirectory, stageDirectory, version }) => {
  assertForkVersion(version);
  const name = linuxAppImageName(version);
  const builderMetadata = join(buildDirectory, "latest-linux.yml");
  verifyLinuxUpdateMetadata({ metadata: readFileSync(builderMetadata, "utf8"), version, appImagePath: join(buildDirectory, name) });
  mkdirSync(stageDirectory, { recursive: true });
  copyFileSync(join(buildDirectory, name), join(stageDirectory, name));
  copyFileSync(builderMetadata, join(stageDirectory, LINUX_UPDATE_CHANNEL_FILE));
  writeFileSync(join(stageDirectory, LINUX_CHECKSUM_FILE), `${hashFile(join(stageDirectory, name), "sha256", "hex")}  ${name}\n`);
  return verifyLinuxRelease(stageDirectory, version);
};

const run = () => {
  const [command, ...args] = process.argv.slice(2);
  if (command === "stage" && args.length === 3) {
    const [buildDirectory, stageDirectory, version] = args;
    const result = stageLinuxRelease({ buildDirectory: resolve(buildDirectory), stageDirectory: resolve(stageDirectory), version });
    return void process.stdout.write(`${JSON.stringify(result)}\n`);
  }
  if (command === "verify" && args.length === 2) {
    return void process.stdout.write(`${JSON.stringify(verifyLinuxRelease(resolve(args[0]), args[1]))}\n`);
  }
  throw new Error("Usage: fork-linux-release.mjs stage <build> <stage> <X.Y.Z-rc.N> | verify <directory> <X.Y.Z-rc.N>");
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();
