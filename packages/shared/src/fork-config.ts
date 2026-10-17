// Renderer mirror of apps/desktop/src/main/fork-config.mjs (lauchiwa/edgeever).
// scripts/fork-invariants.test.mjs asserts both stay identical.

export const FORK_REPOSITORY = "lauchiwa/edgeever";
export const FORK_REPOSITORY_URL = `https://github.com/${FORK_REPOSITORY}`;
// Every fork release is a pre-release (vX.Y.Z-rc.N), which GitHub's
// /releases/latest leaves out, so link to the release list instead.
export const FORK_RELEASES_URL = `${FORK_REPOSITORY_URL}/releases`;
export const FORK_NEW_ISSUE_URL = `${FORK_REPOSITORY_URL}/issues/new`;
// Fork releases are X.Y.Z-rc.N; a bare X.Y.Z is an upstream release.
export const FORK_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)-rc\.(0|[1-9]\d*)$/;
