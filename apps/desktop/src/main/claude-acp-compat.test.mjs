import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { CLAUDE_AUTH_STATUS_SHA256, CLAUDE_COMPAT_VERSIONS, patchClaudeAuthStatus } from "./claude-acp-compat.mjs";

// Small source fixture for the same published CLI-mapping branch. The opt-in
// Windows verifier also exercises the hash-gated transform on the real package.
const source = `
function mapAuthFields(fields) {
  if (fields.apiProvider !== 'firstParty') return {kind:'external'};
  if (fields.apiKeySource) return {kind:'api_key'};
  if (fields.subscriptionType) return {kind:'account',account:{plan:fields.subscriptionType}};
  return {kind:'none'};
}
function fromCliStatus(stdout) {
    const status = JSON.parse(stdout);
    const externalBackend = Boolean(status.apiProvider && status.apiProvider !== 'firstParty');
    return mapAuthFields({
        apiProvider: status.apiProvider,
        apiKeySource: status.apiKeySource,
        subscriptionType: status.subscriptionType,
    });
}
`;
const hash = createHash("sha256").update(source).digest("hex");
const patched = patchClaudeAuthStatus(source, hash);
const map = new Function(`${patched}\nreturn fromCliStatus;`)();
const status = (overrides = {}) => JSON.stringify({ loggedIn: true, authMethod: "oauth_token", apiProvider: "firstParty", ...overrides });

test("reports explicitly logged-in OAuth tokens without inventing a subscription plan", () => {
  expect(map(status())).toEqual({ kind: "account", label: "Claude Code OAuth token" });
  expect(map(status())).not.toHaveProperty("account");
});

test("does not promote logged-out, unknown or malformed identity fields", () => {
  for (const overrides of [{ loggedIn: false }, { loggedIn: undefined }, { loggedIn: "true" }, { authMethod: "unknown" }, { authMethod: undefined }]) {
    expect(map(status(overrides)).kind).toBe("none");
  }
});

test("preserves API key, subscription and external-provider precedence", () => {
  expect(map(status({ apiKeySource: "env" })).kind).toBe("api_key");
  expect(map(status({ subscriptionType: "max" }))).toEqual({ kind: "account", account: { plan: "max" } });
  expect(map(status({ apiProvider: "bedrock" })).kind).toBe("external");
  expect(map(status({ apiProvider: "vertex", loggedIn: false })).kind).toBe("external");
});

test("never patches unknown artifact hashes or an already modified file", () => {
  expect(CLAUDE_AUTH_STATUS_SHA256).toMatch(/^[a-f0-9]{64}$/);
  expect(patchClaudeAuthStatus(source)).toBe(source);
  expect(patchClaudeAuthStatus(`${source}\n`, hash)).toBe(`${source}\n`);
  expect(patchClaudeAuthStatus(patched, hash)).toBe(patched);
  expect(patchClaudeAuthStatus(Buffer.from(source), hash)).toBe(patched);
});

test("applies only to published versions verified to ship the hashed auth-status.js", () => {
  // 0.90.0 and 0.91.0 ship a byte-identical dist/auth-status.js (SHA-256 above).
  expect([...CLAUDE_COMPAT_VERSIONS]).toEqual(["0.90.0", "0.91.0"]);
});
