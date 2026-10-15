// Signs and publishes a fork release prepared as a Draft by
// .github/workflows/fork-release.yml. Its publish job runs it with the primary
// key from the fork-release Environment; it also runs locally as a fallback.
//
//   $env:EDGE_EVER_WINDOWS_UPDATE_SIGNING_KEY = "$HOME\.config\edgeever-fork\windows-update-ed25519-primary.pem"
//   node scripts/fork-sign-release.mjs v1.119.0-rc.0             sign + audit, leave as Draft
//   node scripts/fork-sign-release.mjs v1.119.0-rc.0 --publish   (sign if unsigned) + audit + publish
//   node scripts/fork-sign-release.mjs v1.119.0-rc.0 --resign    replace an existing Draft signature
//
// Steps: check the Draft and its exact asset set, download it, sign
// latest-windows.json unless already signed, upload the signature, download
// all five assets again and audit them exactly as a client would, then (with
// --publish) publish it as a pre-release. Any failure leaves it a Draft,
// which clients never see.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FORK_REPOSITORY } from "../apps/desktop/src/main/fork-config.mjs";
import { WINDOWS_UPDATE_MANIFEST_NAME, WINDOWS_UPDATE_SIGNATURE_NAME } from "../apps/desktop/src/main/windows-update-trust.mjs";
import { WINDOWS_UPDATE_CHANNEL_FILE } from "./create-windows-update-metadata.mjs";
import { parseForkTag } from "./fork-release-version.mjs";
import { promptHidden } from "./fork-secret-prompt.mjs";
import { signWindowsUpdateManifest } from "./sign-windows-update-manifest.mjs";
import { verifyWindowsUpdateRelease } from "./verify-windows-update-release.mjs";

export const releaseAssetNames = (version) => [
  `EdgeEver-${version}-windows-x64.exe`,
  WINDOWS_UPDATE_CHANNEL_FILE,
  WINDOWS_UPDATE_MANIFEST_NAME,
  "SHA256SUMS-windows.txt",
];

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

export const ghClient = (repository = FORK_REPOSITORY) => ({
  // Drafts are only listed, never addressable by tag through the API.
  release(tag) {
    const releases = JSON.parse(execFileSync("gh", ["api", "--paginate", "--slurp", `repos/${repository}/releases?per_page=100`], { encoding: "utf8" })).flat();
    const release = releases.find((item) => item.tag_name === tag);
    return release && { draft: release.draft, prerelease: release.prerelease, assets: release.assets.map((asset) => asset.name) };
  },
  download(tag, names, directory) {
    execFileSync("gh", ["release", "download", tag, "-R", repository, "--dir", directory, ...names.flatMap((name) => ["-p", name])], { stdio: "inherit" });
  },
  upload(tag, path, { clobber = false } = {}) {
    execFileSync("gh", ["release", "upload", tag, path, "-R", repository, ...(clobber ? ["--clobber"] : [])], { stdio: "inherit" });
  },
  publish(tag) {
    execFileSync("gh", ["release", "edit", tag, "-R", repository, "--draft=false", "--prerelease"], { stdio: "inherit" });
  },
});

export const signAndPublishRelease = async ({
  tag,
  gh,
  privateKeyPath,
  passphrase,
  publish = false,
  resign = false,
  trustedPublicKeys,
  workDirectory = mkdtempSync(join(tmpdir(), "edgeever-fork-sign-")),
}) => {
  const { version } = parseForkTag(tag);
  const unsigned = releaseAssetNames(version);
  const signed = [...unsigned, WINDOWS_UPDATE_SIGNATURE_NAME];
  const keyOptions = trustedPublicKeys ? { trustedPublicKeys } : {};
  try {
    const release = gh.release(tag);
    if (!release) throw new Error(`No release ${tag} exists in ${FORK_REPOSITORY}`);
    if (!release.draft) throw new Error(`${tag} is already published; a published release is never re-signed`);
    if (!release.prerelease) throw new Error(`${tag} must be a pre-release (every fork release is)`);
    const actual = [...release.assets].sort();
    const alreadySigned = JSON.stringify(actual) === JSON.stringify([...signed].sort());
    if (!alreadySigned && JSON.stringify(actual) !== JSON.stringify([...unsigned].sort())) {
      throw new Error(`${tag} must contain exactly ${unsigned.join(", ")} (plus its signature once signed); found ${actual.join(", ") || "nothing"}`);
    }
    const sign = !alreadySigned || resign;

    const build = join(workDirectory, "build");
    let keyId = null;
    if (sign) {
      gh.download(tag, unsigned, build);
      for (const name of unsigned) if (!existsSync(join(build, name))) throw new Error(`Download of ${name} failed`);
      const manifestPath = join(build, WINDOWS_UPDATE_MANIFEST_NAME);
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (manifest.version !== version) throw new Error(`latest-windows.json is ${manifest.version}, not ${version}`);
      ({ keyId } = signWindowsUpdateManifest({
        manifestPath,
        signaturePath: join(build, WINDOWS_UPDATE_SIGNATURE_NAME),
        privateKeyPath,
        passphrase,
        ...keyOptions,
      }));
      gh.upload(tag, join(build, WINDOWS_UPDATE_SIGNATURE_NAME), { clobber: alreadySigned });
    }

    // Audit what GitHub now serves, not what was uploaded.
    const audit = join(workDirectory, "audit");
    gh.download(tag, signed, audit);
    const verified = await verifyWindowsUpdateRelease(audit, keyOptions);
    if (sign) {
      for (const name of signed) {
        if (sha256(join(audit, name)) !== sha256(join(build, name))) throw new Error(`${name} on GitHub differs from the signed build`);
      }
    }
    if (publish) gh.publish(tag);
    return { tag, version, signed: sign, keyId: verified.keyId ?? keyId, installer: verified.file.name, sha256: verified.file.sha256, published: publish };
  } finally {
    rmSync(workDirectory, { recursive: true, force: true });
  }
};

export const SIGNING_PASSPHRASE_ENV = "EDGE_EVER_WINDOWS_UPDATE_SIGNING_PASSPHRASE";

// The passphrase comes from the environment only inside GitHub Actions, where
// it is an Environment secret that never touches disk or logs. Anywhere else
// it is prompted for, so it never ends up in a shell profile or history.
export const resolveSigningPassphrase = async ({ env = process.env, prompt = promptHidden } = {}) => {
  if (env.GITHUB_ACTIONS === "true") {
    if (!env[SIGNING_PASSPHRASE_ENV]) throw new Error(`${SIGNING_PASSPHRASE_ENV} is not set; add it to the fork-release environment`);
    return env[SIGNING_PASSPHRASE_ENV];
  }
  if (env[SIGNING_PASSPHRASE_ENV]) throw new Error(`${SIGNING_PASSPHRASE_ENV} is only read in GitHub Actions; unset it and enter the passphrase when asked`);
  return prompt("Signing key passphrase: ");
};

const run = async () => {
  const args = process.argv.slice(2);
  const tag = args.find((value) => !value.startsWith("--"));
  if (!tag) throw new Error("Usage: fork-sign-release.mjs <vX.Y.Z-rc.N> [--publish] [--resign]");
  const publish = args.includes("--publish");
  const resign = args.includes("--resign");
  const gh = ghClient();
  const release = gh.release(tag);
  const needsKey = !release?.assets?.includes(WINDOWS_UPDATE_SIGNATURE_NAME) || resign;
  const privateKeyPath = process.env.EDGE_EVER_WINDOWS_UPDATE_SIGNING_KEY;
  if (needsKey && !privateKeyPath) throw new Error("Set EDGE_EVER_WINDOWS_UPDATE_SIGNING_KEY to the primary key file");
  const passphrase = needsKey && readFileSync(privateKeyPath, "utf8").includes("BEGIN ENCRYPTED PRIVATE KEY")
    ? await resolveSigningPassphrase()
    : undefined;
  const result = await signAndPublishRelease({ tag, gh, privateKeyPath, passphrase, publish, resign });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.published) process.stdout.write(`Audited and left as a Draft. Publish with: node scripts/fork-sign-release.mjs ${tag} --publish\n`);
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await run();
