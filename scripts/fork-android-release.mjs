// Android arm64 APK of a fork release (see docs/fork-releases.md).
//
//   node scripts/fork-android-release.mjs stage <signed.apk> <stage> <X.Y.Z-rc.N>
//   node scripts/fork-android-release.mjs verify <directory> <X.Y.Z-rc.N>
//
// The android-sign job of fork-release.yml signs the APK with the fork
// keystore and stages it with an independent checksum list; the publish job
// re-downloads both and, with EDGE_EVER_ANDROID_ALLOWED_SIGNER_SHA256 set,
// checks again with apksigner that the fork certificate is the only signer.
// Android has no update channel file: the fork APK never updates itself.
// Node built-ins only: the jobs that run this install nothing.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FORK_VERSION_PATTERN } from "../apps/desktop/src/main/fork-config.mjs";

export const ANDROID_CHECKSUM_FILE = "SHA256SUMS-android.txt";
export const androidApkName = (version) => `EdgeEver-${version}-android-arm64.apk`;
export const androidReleaseAssetNames = (version) => [androidApkName(version), ANDROID_CHECKSUM_FILE];
export const ANDROID_SIGNER_ENV = "EDGE_EVER_ANDROID_ALLOWED_SIGNER_SHA256";

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

const assertForkVersion = (version) => {
  if (!FORK_VERSION_PATTERN.test(version ?? "")) throw new Error(`Android release version must be a fork release X.Y.Z-rc.N: ${version}`);
};

// Runs the repository's signer check (apksigner, exactly one allowed signer).
export const apksignerSignerCheck = (apkPath) => {
  const script = fileURLToPath(new URL("./verify-android-apk-signature.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script, apkPath], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`Android signer check failed for ${apkPath}:\n${result.stdout}${result.stderr}`);
  return result.stdout.match(/SHA-256: ([0-9a-f]{64})/)?.[1] ?? null;
};

// Checks a directory holding exactly the APK and its checksum list, as staged
// by CI or as downloaded again from GitHub before publishing.
export const verifyAndroidRelease = (directory, version, { checkSigner } = {}) => {
  assertForkVersion(version);
  const expected = [...androidReleaseAssetNames(version)].sort();
  const actual = readdirSync(directory).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Android release must contain exactly ${expected.join(", ")}; found ${actual.join(", ") || "nothing"}`);
  }
  const name = androidApkName(version);
  const apkPath = join(directory, name);
  const size = statSync(apkPath).size;
  if (size <= 0) throw new Error(`Android APK is empty: ${apkPath}`);
  const digest = sha256(apkPath);
  if (readFileSync(join(directory, ANDROID_CHECKSUM_FILE), "utf8") !== `${digest}  ${name}\n`) {
    throw new Error(`${ANDROID_CHECKSUM_FILE} does not exactly match the APK`);
  }
  const signerSha256 = checkSigner ? checkSigner(apkPath) : null;
  return { version, file: { name, size, sha256: digest }, signerSha256 };
};

// In GitHub Actions the signer is always checked; locally only when the
// allowed fingerprint is set (the maintainer's fallback may lack apksigner).
export const defaultAndroidSignerCheck = (env = process.env) => {
  if (env[ANDROID_SIGNER_ENV]) return apksignerSignerCheck;
  if (env.GITHUB_ACTIONS === "true") throw new Error(`${ANDROID_SIGNER_ENV} is not set; pass the FORK_ANDROID_SIGNER_SHA256 variable`);
  return undefined;
};

// Copies the signed APK under its release name and writes the checksum list.
export const stageAndroidRelease = ({ apkPath, stageDirectory, version, checkSigner }) => {
  assertForkVersion(version);
  mkdirSync(stageDirectory, { recursive: true });
  const name = androidApkName(version);
  copyFileSync(apkPath, join(stageDirectory, name));
  writeFileSync(join(stageDirectory, ANDROID_CHECKSUM_FILE), `${sha256(join(stageDirectory, name))}  ${name}\n`);
  return verifyAndroidRelease(stageDirectory, version, { checkSigner });
};

const run = () => {
  const [command, ...args] = process.argv.slice(2);
  if (command === "stage" && args.length === 3) {
    const [apkPath, stageDirectory, version] = args;
    const result = stageAndroidRelease({ apkPath: resolve(apkPath), stageDirectory: resolve(stageDirectory), version, checkSigner: defaultAndroidSignerCheck() });
    return void process.stdout.write(`${JSON.stringify(result)}\n`);
  }
  if (command === "verify" && args.length === 2) {
    return void process.stdout.write(`${JSON.stringify(verifyAndroidRelease(resolve(args[0]), args[1], { checkSigner: defaultAndroidSignerCheck() }))}\n`);
  }
  throw new Error("Usage: fork-android-release.mjs stage <signed.apk> <stage> <X.Y.Z-rc.N> | verify <directory> <X.Y.Z-rc.N>");
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();
