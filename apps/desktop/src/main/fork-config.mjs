// Single source of truth for this fork's identity (lauchiwa/edgeever).
// Upstream files import from here so an upstream sync touches one import line,
// not scattered literals. scripts/fork-invariants.test.mjs fails if any of
// these drift back to upstream, or if a new upstream literal appears.
// Mirror: packages/shared/src/fork-config.ts (renderer). Keep both identical.

export const FORK_REPOSITORY = "lauchiwa/edgeever";
export const FORK_REPOSITORY_URL = `https://github.com/${FORK_REPOSITORY}`;
// GitHub's /releases/latest excludes pre-releases, and every fork release is
// one (vX.Y.Z-rc.N), so links use the release list, never /releases/latest.
export const FORK_RELEASES_URL = `${FORK_REPOSITORY_URL}/releases`;
export const FORK_NEW_ISSUE_URL = `${FORK_REPOSITORY_URL}/issues/new`;

// X.Y.Z = upstream version synced from; N = this fork's releases on top of it.
// A bare X.Y.Z is never published: SemVer ranks it above every X.Y.Z-rc.N, and
// a custom "rc" channel is isolated in electron-updater (alpha/beta also accept
// stable releases). See docs/fork-releases.md.
export const FORK_RELEASE_CHANNEL = "rc";
export const FORK_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)-rc\.(0|[1-9]\d*)$/;

// Ed25519 public keys trusted for latest-windows.json. The private keys never
// enter this repository or GitHub Actions; they are generated and kept offline
// by scripts/fork-generate-update-keys.mjs. Primary signs releases; backup is
// kept cold and only signs a key-rotation release if the primary is lost or
// leaked. Fingerprints are SHA-256 of the SPKI DER. Changing either key
// orphans every installed client that pins only the old pair.
export const FORK_WINDOWS_UPDATE_KEYS = Object.freeze({
  primary: Object.freeze({
    keyId: "lauchiwa-edgeever-windows-update-2026-10-a",
    // sha256: 1a383c020d4df0d48d77a715bee892e9c90527baf1ffb5d60172c2b8b46767a0
    publicKeyPem: `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAKrzZXf12CFUZpHgx35ShTJfzX6pMD4QtvAmlrC9a5AA=
-----END PUBLIC KEY-----`,
  }),
  backup: Object.freeze({
    keyId: "lauchiwa-edgeever-windows-update-2026-10-b",
    // sha256: 22c1cb666119ae2907c7111083c346079907f67caf8621bc220748b703106f7d
    publicKeyPem: `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAUe8UoX4j9K60H/bX41H4xpZcCRKVR+Gt8kVmg4d+Dys=
-----END PUBLIC KEY-----`,
  }),
});

export const forkTrustedWindowsUpdateKeys = () => Object.freeze(Object.fromEntries(
  Object.values(FORK_WINDOWS_UPDATE_KEYS)
    .filter((key) => typeof key.publicKeyPem === "string" && key.publicKeyPem.includes("BEGIN PUBLIC KEY"))
    .map((key) => [key.keyId, key.publicKeyPem]),
));
