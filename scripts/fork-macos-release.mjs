// macOS arm64 and x64 assets of a fork release (see docs/fork-releases.md).
//
//   node scripts/fork-macos-release.mjs sign-release <builds> <stage> <predecessors> <X.Y.Z-rc.N>
//   node scripts/fork-macos-release.mjs check-zip <zip> <directory> <X.Y.Z-rc.N> <arm64|x64>
//   node scripts/fork-macos-release.mjs check-dmg <dmg> <X.Y.Z-rc.N> <arm64|x64>
//   node scripts/fork-macos-release.mjs verify <directory> <X.Y.Z-rc.N>
//
// The fork has no Apple Developer ID, so electron-builder leaves the app
// unsigned and the macos-sign job of fork-release.yml signs it here with the
// self-signed primary certificate pinned in fork-config.mjs. The outer app
// carries an explicit designated requirement (bundle id and either pinned
// certificate), which Squirrel.Mac checks before installing an update; an
// ad-hoc signature would pin one build's cdhash and refuse every update.
// Clients find the zip through rc-mac.yml (their channel) and check its
// sha512; SHA256SUMS-macos.txt lists every zip and dmg independently. The
// app is not notarized: Gatekeeper blocks its first launch until allowed.
//
// Only node: built-ins and macOS tools (codesign, security, ditto, hdiutil,
// plutil, lipo): the signing job installs no dependencies.
import { spawnSync } from "node:child_process";
import { X509Certificate, createHash, createPrivateKey, createPublicKey, randomBytes } from "node:crypto";
import {
  closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, readlinkSync,
  rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FORK_MACOS_BUNDLE_ID, FORK_MACOS_SIGNING_CERTIFICATES, FORK_RELEASE_CHANNEL, FORK_VERSION_PATTERN,
} from "../apps/desktop/src/main/fork-config.mjs";

export const MAC_ARCHES = Object.freeze(["arm64", "x64"]);
export const MAC_UPDATE_CHANNEL_FILE = `${FORK_RELEASE_CHANNEL}-mac.yml`;
export const MAC_CHECKSUM_FILE = "SHA256SUMS-macos.txt";
export const macZipName = (version, arch) => `EdgeEver-${version}-mac-${arch}.zip`;
export const macDmgName = (version, arch) => `EdgeEver-${version}-mac-${arch}.dmg`;
const macBinaryNames = (version) => MAC_ARCHES.flatMap((arch) => [macZipName(version, arch), macDmgName(version, arch)]);
export const macReleaseAssetNames = (version) => [...macBinaryNames(version), MAC_UPDATE_CHANNEL_FILE, MAC_CHECKSUM_FILE];

const EXTENSION_ENTITLEMENTS = fileURLToPath(new URL("../apps/desktop/share-extension/EdgeEverShare.entitlements", import.meta.url));
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const hashFile = (path, algorithm, encoding) => createHash(algorithm).update(readFileSync(path)).digest(encoding);
const sleep = (milliseconds) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);

const assertForkVersion = (version) => {
  if (!FORK_VERSION_PATTERN.test(version ?? "")) throw new Error(`macOS release version must be a fork release X.Y.Z-rc.N: ${version}`);
};
const assertArch = (arch) => {
  if (!MAC_ARCHES.includes(arch)) throw new Error(`macOS architecture must be ${MAC_ARCHES.join(" or ")}: ${arch}`);
};

// --- Pinned certificates and the designated requirement ---------------------

export const macCertificateSha1 = (pem) => new X509Certificate(pem).fingerprint.replaceAll(":", "").toLowerCase();

export const pinnedMacCertificates = (certificates = FORK_MACOS_SIGNING_CERTIFICATES) => {
  const pems = [certificates.primary?.certificatePem, certificates.backup?.certificatePem];
  if (pems.some((pem) => typeof pem !== "string" || !pem.includes("BEGIN CERTIFICATE"))) {
    throw new Error("Pin both macOS signing certificates in fork-config.mjs (scripts/fork-generate-macos-signing-certificates.mjs)");
  }
  const hashes = pems.map(macCertificateSha1);
  if (hashes[0] === hashes[1]) throw new Error("The primary and backup macOS signing certificates must differ");
  return { primary: { pem: pems[0], sha1: hashes[0] }, backup: { pem: pems[1], sha1: hashes[1] } };
};

// The requirement every fork build carries, so any build signed by either
// certificate satisfies the one installed (Squirrel.Mac's update check).
export const macDesignatedRequirement = (certificates) => {
  const { primary, backup } = pinnedMacCertificates(certificates);
  return `identifier "${FORK_MACOS_BUNDLE_ID}" and (certificate leaf = H"${primary.sha1}" or certificate leaf = H"${backup.sha1}")`;
};

// --- What to sign, inside out ------------------------------------------------

const MACHO_MAGIC = new Set(["feedfacf", "cffaedfe", "feedface", "cefaedfe", "cafebabe", "bebafeca"]);
const BUNDLE_SUFFIX = /\.(?:app|appex|framework|xpc|bundle|plugin)$/;

const isMachO = (path) => {
  const header = Buffer.alloc(8);
  const fd = openSync(path, "r");
  try {
    if (readSync(fd, header, 0, 8, 0) < 8) return false;
  } finally {
    closeSync(fd);
  }
  const magic = header.subarray(0, 4).toString("hex");
  if (!MACHO_MAGIC.has(magic)) return false;
  // 0xcafebabe is also a Java class file; a fat Mach-O lists only a few architectures.
  return magic !== "cafebabe" || header.readUInt32BE(4) < 20;
};

const bundleExecutable = (plistPath, fallback) => {
  const match = /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/.exec(readFileSync(plistPath, "utf8"));
  return match ? match[1] : fallback;
};

// The physical Info.plist of a bundle, and where its main executable lives.
const bundleLayout = (path) => {
  const name = basename(path).replace(BUNDLE_SUFFIX, "");
  if (path.endsWith(".framework")) {
    const versions = join(path, "Versions");
    if (!existsSync(versions) || !lstatSync(versions).isDirectory()) {
      const plist = join(path, "Resources", "Info.plist");
      return existsSync(plist) ? { executables: [join(path, bundleExecutable(plist, name))] } : null;
    }
    const executables = readdirSync(versions)
      .filter((version) => !lstatSync(join(versions, version)).isSymbolicLink())
      .flatMap((version) => {
        const plist = join(versions, version, "Resources", "Info.plist");
        return existsSync(plist) ? [join(versions, version, bundleExecutable(plist, name))] : [];
      });
    return executables.length ? { executables } : null;
  }
  const plist = join(path, "Contents", "Info.plist");
  return existsSync(plist) ? { executables: [join(path, "Contents", "MacOS", bundleExecutable(plist, name))] } : null;
};

// Every nested bundle and loose Mach-O file under appPath, deepest first, the
// app itself last: codesign seals what is already signed inside a bundle.
// Symbolic links are never followed or signed; main executables are signed
// with their bundle.
export const macSigningPlan = (appPath) => {
  if (!appPath.endsWith(".app") || !bundleLayout(appPath)) throw new Error(`Not an app bundle: ${appPath}`);
  const items = [];
  const mainExecutables = new Set();
  const visit = (directory) => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        const layout = BUNDLE_SUFFIX.test(entry) && bundleLayout(path);
        if (layout) {
          for (const executable of layout.executables) mainExecutables.add(executable);
          items.push({ path, kind: entry.endsWith(".appex") ? "extension" : "bundle" });
        }
        visit(path);
      } else if (stat.isFile() && isMachO(path)) {
        items.push({ path, kind: "file" });
      }
    }
  };
  for (const executable of bundleLayout(appPath).executables) mainExecutables.add(executable);
  visit(appPath);
  const depth = (path) => relative(appPath, path).split(sep).length;
  const nested = items
    .filter((item) => !mainExecutables.has(item.path))
    .sort((a, b) => depth(b.path) - depth(a.path) || a.path.localeCompare(b.path));
  return [...nested, { path: appPath, kind: "app" }];
};
// --- macOS tools ---------------------------------------------------------------

// Errors name the tool and its first argument only: arguments can hold a
// throwaway keychain password.
const tool = (command, args, { both = false } = {}) => {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args[0] ?? ""} failed (${result.status}): ${(result.stderr || result.stdout || "").trim()}`);
  }
  return both ? `${result.stdout}\n${result.stderr}` : result.stdout;
};

// Signs every item of macSigningPlan with identity (a certificate SHA-1 in
// keychain). Nested code keeps its own identifier; the app gets the bundle id
// and the designated requirement. No hardened runtime and no timestamp: the
// app is not notarized, and there is no timestamp authority for this chain.
export const signMacApp = ({ appPath, identity, keychain, certificates }) => {
  const requirement = macDesignatedRequirement(certificates);
  tool("xattr", ["-cr", appPath]);
  const plan = macSigningPlan(appPath);
  for (const { path, kind } of plan) {
    const args = ["--force", "--sign", identity, "--keychain", keychain, "--timestamp=none"];
    if (kind === "extension") args.push("--entitlements", EXTENSION_ENTITLEMENTS, "--generate-entitlement-der");
    if (kind === "app") args.push("--identifier", FORK_MACOS_BUNDLE_ID, `-r=designated => ${requirement}`);
    tool("codesign", [...args, path]);
  }
  return plan.length;
};

export const plistValue = (plistPath, key) => tool("plutil", ["-extract", key, "raw", "-o", "-", plistPath]).trim();

// What Squirrel.Mac checks, plus what this release must be: the version, the
// architecture and the sandboxed share extension.
export const checkMacSignature = (appPath, { version, arch, certificates } = {}) => {
  assertForkVersion(version);
  assertArch(arch);
  const requirement = macDesignatedRequirement(certificates);
  const { primary, backup } = pinnedMacCertificates(certificates);
  tool("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
  tool("codesign", ["--verify", "--deep", "--strict", "-R", `=${requirement}`, appPath]);
  const details = tool("codesign", ["--display", "--verbose=4", "-r-", appPath], { both: true });
  const designated = /designated => (.+)/.exec(details)?.[1]?.toLowerCase() ?? "";
  for (const expected of [`identifier "${FORK_MACOS_BUNDLE_ID}"`, primary.sha1, backup.sha1]) {
    if (!designated.includes(expected.toLowerCase())) throw new Error(`${appPath} does not carry the fork designated requirement`);
  }
  if (!new RegExp(`^Identifier=${escapeRegExp(FORK_MACOS_BUNDLE_ID)}$`, "m").test(details)) {
    throw new Error(`${appPath} is not signed as ${FORK_MACOS_BUNDLE_ID}`);
  }
  const cdhash = /^CDHash=([0-9a-f]{40,64})$/m.exec(details)?.[1];
  if (!cdhash) throw new Error(`${appPath} has no CDHash`);
  const plist = join(appPath, "Contents", "Info.plist");
  if (plistValue(plist, "CFBundleIdentifier") !== FORK_MACOS_BUNDLE_ID) throw new Error(`${appPath} is not ${FORK_MACOS_BUNDLE_ID}`);
  if (plistValue(plist, "CFBundleShortVersionString") !== version) throw new Error(`${appPath} is not version ${version}`);
  const executable = join(appPath, "Contents", "MacOS", plistValue(plist, "CFBundleExecutable"));
  const architectures = tool("lipo", ["-archs", executable]).trim().split(/\s+/);
  if (architectures.join(" ") !== (arch === "arm64" ? "arm64" : "x86_64")) {
    throw new Error(`${executable} is ${architectures.join(" ")}, not ${arch}`);
  }
  const extension = join(appPath, "Contents", "PlugIns", "EdgeEverShare.appex");
  const entitlements = tool("codesign", ["--display", "--entitlements", "-", "--xml", extension]);
  if (!/<key>com\.apple\.security\.app-sandbox<\/key>\s*<true\/>/.test(entitlements)) {
    throw new Error(`${extension} lost its App Sandbox entitlement`);
  }
  return { appPath, version, arch, cdhash };
};
// --- Packaging -----------------------------------------------------------------

// ditto keeps the signature, symbolic links and permissions intact, as
// electron-builder and Squirrel.Mac expect; zip(1) does not.
export const zipMacApp = (appPath, zipPath) => {
  rmSync(zipPath, { force: true });
  tool("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", appPath, zipPath]);
};

export const extractMacApp = (zipPath, directory) => {
  mkdirSync(directory, { recursive: true });
  if (readdirSync(directory).length) throw new Error(`Extract into an empty directory: ${directory}`);
  tool("ditto", ["-x", "-k", zipPath, directory]);
  const entries = readdirSync(directory);
  if (entries.length !== 1 || entries[0] !== "EdgeEver.app") throw new Error(`${zipPath} must hold exactly EdgeEver.app; found ${entries.join(", ")}`);
  return join(directory, "EdgeEver.app");
};

// hdiutil fails transiently ("Resource busy") on CI runners.
const retry = (attempts, action) => {
  for (let attempt = 1; ; attempt += 1) {
    try { return action(attempt); } catch (error) {
      if (attempt >= attempts) throw error;
      sleep(2000 * attempt);
    }
  }
};

// Mounts dmgPath read-only and hidden, runs check(appPath) on its app, and
// always detaches it again.
export const withMountedMacDmg = (dmgPath, check) => {
  const mountpoint = mkdtempSync(join(tmpdir(), "edgeever-fork-dmg-"));
  try {
    retry(3, () => tool("hdiutil", ["attach", "-readonly", "-nobrowse", "-noautoopen", "-mountpoint", mountpoint, dmgPath]));
    try {
      const link = join(mountpoint, "Applications");
      if (!lstatSync(link).isSymbolicLink() || readlinkSync(link) !== "/Applications") throw new Error(`${dmgPath} has no Applications link`);
      const entries = readdirSync(mountpoint).filter((name) => !name.startsWith("."));
      if (entries.sort().join(",") !== "Applications,EdgeEver.app") throw new Error(`${dmgPath} holds unexpected files: ${entries.join(", ")}`);
      return check(join(mountpoint, "EdgeEver.app"));
    } finally {
      retry(3, (attempt) => tool("hdiutil", ["detach", mountpoint, ...(attempt > 1 ? ["-force"] : [])]));
    }
  } finally {
    rmSync(mountpoint, { recursive: true, force: true });
  }
};

// A plain drag-to-Applications image (no background art), compressed.
export const createMacDmg = (appPath, dmgPath) => {
  const staging = mkdtempSync(join(tmpdir(), "edgeever-fork-dmg-staging-"));
  try {
    tool("ditto", [appPath, join(staging, "EdgeEver.app")]);
    symlinkSync("/Applications", join(staging, "Applications"));
    rmSync(dmgPath, { force: true });
    retry(3, () => {
      rmSync(dmgPath, { force: true });
      tool("hdiutil", ["create", "-volname", "EdgeEver", "-srcfolder", staging, "-fs", "HFS+", "-format", "UDZO", "-ov", dmgPath]);
    });
    tool("hdiutil", ["verify", dmgPath]);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
};
// --- Update metadata and the release audit -------------------------------------

// Upstream's create-mac-update-metadata.mjs layout (arm64 first, top-level
// path/sha512 = arm64), for fork versions. electron-updater picks the zip of
// the running architecture; there are no block maps, so updates download in full.
export const buildMacUpdateMetadata = ({ directory, version, releaseDate = new Date().toISOString() }) => {
  assertForkVersion(version);
  const files = MAC_ARCHES.map((arch) => {
    const path = join(directory, macZipName(version, arch));
    return { url: macZipName(version, arch), sha512: hashFile(path, "sha512", "base64"), size: statSync(path).size };
  });
  return [
    `version: ${version}`,
    "files:",
    ...files.flatMap((file) => [`  - url: ${file.url}`, `    sha512: ${file.sha512}`, `    size: ${file.size}`]),
    `path: ${files[0].url}`,
    `sha512: ${files[0].sha512}`,
    `releaseDate: '${releaseDate}'`,
    "",
  ].join("\n");
};

export const verifyMacUpdateMetadata = ({ metadata, version, directory }) => {
  assertForkVersion(version);
  // Only the lines written above; anything else could change what the updater reads.
  const known = /^(?:version: \S+|files:| {2}- url: \S+| {4}sha512: \S+| {4}size: \d+|path: \S+|sha512: \S+|releaseDate: '[^']+')$/;
  const lines = metadata.split("\n");
  if (lines.pop() !== "" || lines.some((line) => !known.test(line))) throw new Error("macOS update metadata has unexpected content");
  const files = MAC_ARCHES.map((arch) => {
    const path = join(directory, macZipName(version, arch));
    const size = statSync(path).size;
    if (size <= 0) throw new Error(`macOS zip is empty: ${path}`);
    return { url: macZipName(version, arch), sha512: hashFile(path, "sha512", "base64"), size };
  });
  const expected = [
    `version: ${version}`,
    "files:",
    ...files.flatMap((file) => [`  - url: ${file.url}`, `    sha512: ${file.sha512}`, `    size: ${file.size}`]),
    `path: ${files[0].url}`,
    `sha512: ${files[0].sha512}`,
  ];
  const releaseDate = lines.pop();
  if (!/^releaseDate: '\d{4}-\d{2}-\d{2}T[\d:.]+Z'$/.test(releaseDate ?? "") || JSON.stringify(lines) !== JSON.stringify(expected)) {
    throw new Error(`macOS update metadata must select exactly the ${version} zips by digest and size`);
  }
  return files;
};

const readTail = (path, length) => {
  const size = statSync(path).size;
  const buffer = Buffer.alloc(Math.min(length, size));
  const fd = openSync(path, "r");
  try { readSync(fd, buffer, 0, buffer.length, size - buffer.length); } finally { closeSync(fd); }
  return buffer;
};

// Checks a directory holding exactly the six macOS assets, as staged by the
// signing job or downloaded again from GitHub before publishing. Signatures
// need macOS; see checkMacSignature.
export const verifyMacRelease = (directory, version) => {
  assertForkVersion(version);
  const expected = [...macReleaseAssetNames(version)].sort();
  const actual = readdirSync(directory).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`macOS release must contain exactly ${expected.join(", ")}; found ${actual.join(", ") || "nothing"}`);
  }
  verifyMacUpdateMetadata({ metadata: readFileSync(join(directory, MAC_UPDATE_CHANNEL_FILE), "utf8"), version, directory });
  const files = macBinaryNames(version).map((name) => {
    const path = join(directory, name);
    const isZip = name.endsWith(".zip");
    const valid = isZip ? readFileSync(path).subarray(0, 4).equals(Buffer.from("PK\x03\x04", "latin1"))
      : readTail(path, 512).subarray(0, 4).toString("latin1") === "koly";
    if (!valid) throw new Error(`${name} is not a ${isZip ? "zip archive" : "disk image"}`);
    return { name, size: statSync(path).size, sha512: hashFile(path, "sha512", "base64"), sha256: hashFile(path, "sha256", "hex") };
  });
  const checksums = files.map((file) => `${file.sha256}  ${file.name}\n`).join("");
  if (readFileSync(join(directory, MAC_CHECKSUM_FILE), "utf8") !== checksums) {
    throw new Error(`${MAC_CHECKSUM_FILE} does not exactly match the zips and disk images`);
  }
  return { version, files };
};
// --- The signing identity ------------------------------------------------------

// Runs use(identity, keychain) with a throwaway keychain holding only this
// certificate and key. The key is written unencrypted to a 0600 file, in a
// 0700 directory, only for `security import`, and deleted right after; the
// user's keychain search list is restored and the keychain deleted however
// use() ends.
export const withMacSigningKeychain = ({ privateKey, certificatePem }, use) => {
  const certificate = new X509Certificate(certificatePem);
  if (!certificate.publicKey.equals(createPublicKey(privateKey))) throw new Error("The macOS signing key does not match its certificate");
  const directory = mkdtempSync(join(tmpdir(), "edgeever-fork-macos-signing-"));
  const keychain = join(directory, "signing.keychain-db");
  const password = randomBytes(24).toString("hex");
  const searchList = [...tool("security", ["list-keychains", "-d", "user"]).matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  let created = false;
  try {
    const keyPath = join(directory, "key.pem");
    const certificatePath = join(directory, "certificate.der");
    writeFileSync(keyPath, privateKey.export({ type: "pkcs1", format: "pem" }), { flag: "wx", mode: 0o600 });
    try {
      writeFileSync(certificatePath, certificate.raw, { flag: "wx", mode: 0o600 });
      tool("security", ["create-keychain", "-p", password, keychain]);
      created = true;
      tool("security", ["set-keychain-settings", "-lut", "21600", keychain]);
      tool("security", ["unlock-keychain", "-p", password, keychain]);
      tool("security", ["import", certificatePath, "-k", keychain, "-f", "x509", "-t", "cert", "-T", "/usr/bin/codesign"]);
      tool("security", ["import", keyPath, "-k", keychain, "-f", "openssl", "-t", "priv", "-P", "", "-T", "/usr/bin/codesign"]);
    } finally {
      rmSync(keyPath, { force: true });
    }
    tool("security", ["set-key-partition-list", "-S", "apple-tool:,apple:", "-s", "-k", password, keychain]);
    tool("security", ["list-keychains", "-d", "user", "-s", keychain, ...searchList]);
    // Self-signed, so it is never "valid" (trusted): look for it without -v.
    const identity = macCertificateSha1(certificatePem).toUpperCase();
    if (!tool("security", ["find-identity", "-p", "codesigning", keychain]).includes(identity)) {
      throw new Error("The macOS signing identity did not import");
    }
    return use(identity, keychain);
  } finally {
    if (created) {
      try { tool("security", ["list-keychains", "-d", "user", "-s", ...searchList]); } finally {
        tool("security", ["delete-keychain", keychain]);
      }
    }
    rmSync(directory, { recursive: true, force: true });
  }
};

export const SIGNING_KEY_ENV = "EDGE_EVER_MACOS_SIGNING_KEY";
export const SIGNING_PASSPHRASE_ENV = "EDGE_EVER_MACOS_SIGNING_PASSPHRASE";

// The primary key only: the backup never enters GitHub, so a key matching it
// (or nothing pinned) is refused. The passphrase is an Environment secret,
// read only inside GitHub Actions.
export const loadMacSigningKey = ({ env = process.env, certificates } = {}) => {
  if (env.GITHUB_ACTIONS !== "true") throw new Error("macOS release signing runs only in the macos-sign job of fork-release.yml");
  if (!env[SIGNING_KEY_ENV] || !env[SIGNING_PASSPHRASE_ENV]) {
    throw new Error(`${SIGNING_KEY_ENV} and ${SIGNING_PASSPHRASE_ENV} must be set; add both secrets to the fork-macos environment`);
  }
  const pem = readFileSync(env[SIGNING_KEY_ENV], "utf8");
  if (!pem.includes("BEGIN ENCRYPTED PRIVATE KEY")) throw new Error("The macOS signing key must be passphrase-encrypted PKCS#8");
  const privateKey = createPrivateKey({ key: pem, format: "pem", passphrase: env[SIGNING_PASSPHRASE_ENV] });
  const { primary, backup } = pinnedMacCertificates(certificates);
  const spki = (key) => (key.type === "public" ? key : createPublicKey(key)).export({ type: "spki", format: "der" });
  const own = spki(privateKey);
  if (!own.equals(spki(new X509Certificate(primary.pem).publicKey))) {
    throw new Error(own.equals(spki(new X509Certificate(backup.pem).publicKey))
      ? "This is the cold backup macOS key; CI signs only with the primary"
      : "The macOS signing key does not match the pinned primary certificate");
  }
  return { privateKey, certificatePem: primary.pem };
};
// --- The macos-sign job --------------------------------------------------------

// builds/<arch>/ (from the macos build job) holds EdgeEver.app.zip (unsigned),
// predecessor.zip and predecessor.json ({ source: "release" | "built",
// version }). A "built" predecessor is this source at an older rc version,
// signed here too; a "release" one is the previous published zip, only checked.
// Writes the six release assets to stage and <predecessors>/<arch>.zip for
// the update gate, then re-checks every shipped zip and disk image.
export const signMacRelease = ({ builds, stage, predecessors, version, identity, keychain, certificates }) => {
  assertForkVersion(version);
  mkdirSync(stage, { recursive: true });
  mkdirSync(predecessors, { recursive: true });
  if (readdirSync(stage).length) throw new Error(`The macOS stage directory must start empty: ${stage}`);
  const work = mkdtempSync(join(tmpdir(), "edgeever-fork-macos-release-"));
  const result = {};
  try {
    for (const arch of MAC_ARCHES) {
      const build = join(builds, arch);
      const predecessor = JSON.parse(readFileSync(join(build, "predecessor.json"), "utf8"));
      if (!["release", "built"].includes(predecessor.source)) throw new Error(`Unknown ${arch} predecessor source: ${predecessor.source}`);
      assertForkVersion(predecessor.version);
      if (predecessor.version === version) throw new Error(`The ${arch} update predecessor must be an older version than ${version}`);

      const app = extractMacApp(join(build, "EdgeEver.app.zip"), join(work, arch, "release"));
      signMacApp({ appPath: app, identity, keychain, certificates });
      const { cdhash } = checkMacSignature(app, { version, arch, certificates });
      zipMacApp(app, join(stage, macZipName(version, arch)));
      createMacDmg(app, join(stage, macDmgName(version, arch)));

      const oldApp = extractMacApp(join(build, "predecessor.zip"), join(work, arch, "predecessor"));
      if (predecessor.source === "built") signMacApp({ appPath: oldApp, identity, keychain, certificates });
      checkMacSignature(oldApp, { version: predecessor.version, arch, certificates });
      zipMacApp(oldApp, join(predecessors, `${arch}.zip`));
      result[arch] = { cdhash, predecessor };
    }
    writeFileSync(join(stage, MAC_UPDATE_CHANNEL_FILE), buildMacUpdateMetadata({ directory: stage, version }));
    writeFileSync(join(stage, MAC_CHECKSUM_FILE), macBinaryNames(version)
      .map((name) => `${hashFile(join(stage, name), "sha256", "hex")}  ${name}\n`).join(""));
    // Check what ships, not the working copy.
    for (const arch of MAC_ARCHES) {
      const shipped = checkMacSignature(extractMacApp(join(stage, macZipName(version, arch)), join(work, arch, "shipped")), { version, arch, certificates });
      const mounted = withMountedMacDmg(join(stage, macDmgName(version, arch)), (app) => checkMacSignature(app, { version, arch, certificates }));
      if (shipped.cdhash !== result[arch].cdhash || mounted.cdhash !== result[arch].cdhash) {
        throw new Error(`The ${arch} zip and disk image do not hold the signed app`);
      }
    }
    return { ...verifyMacRelease(stage, version), signed: result };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
};

const run = () => {
  const [command, ...args] = process.argv.slice(2);
  const print = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
  if (command === "sign-release" && args.length === 4) {
    const [builds, stage, predecessors, version] = args.map((value, index) => (index < 3 ? resolve(value) : value));
    const signingKey = loadMacSigningKey();
    return print(withMacSigningKeychain(signingKey, (identity, keychain) => signMacRelease({ builds, stage, predecessors, version, identity, keychain })));
  }
  if (command === "check-zip" && args.length === 4) {
    const [zip, directory, version, arch] = args;
    return print(checkMacSignature(extractMacApp(resolve(zip), resolve(directory)), { version, arch }));
  }
  if (command === "check-dmg" && args.length === 3) {
    const [dmg, version, arch] = args;
    return print(withMountedMacDmg(resolve(dmg), (app) => checkMacSignature(app, { version, arch })));
  }
  if (command === "verify" && args.length === 2) return print(verifyMacRelease(resolve(args[0]), args[1]));
  throw new Error([
    "Usage: fork-macos-release.mjs sign-release <builds> <stage> <predecessors> <X.Y.Z-rc.N>",
    "     | check-zip <zip> <directory> <X.Y.Z-rc.N> <arm64|x64> | check-dmg <dmg> <X.Y.Z-rc.N> <arm64|x64>",
    "     | verify <directory> <X.Y.Z-rc.N>",
  ].join("\n"));
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();
