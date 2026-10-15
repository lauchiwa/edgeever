import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as nodeModule from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Temporary compatibility for the published claude-agent-acp 0.90.0 and 0.91.0
// artifacts, which ship a byte-identical dist/auth-status.js.
// Its CLI mapper drops authMethod and reports loggedIn:true/oauth_token as none
// when there is no subscription plan. Do not infer a plan or bypass login checks.
export const CLAUDE_AUTH_STATUS_SHA256 = "ed7284417722a046dee8f057bd8c1291d809e9f3981197ae747674f24c9f353a";
// Versions whose published auth-status.js was verified to match the hash above.
// The hash check still gates every rewrite.
export const CLAUDE_COMPAT_VERSIONS = new Set(["0.90.0", "0.91.0"]);
const marker = "    return mapAuthFields({\n        apiProvider: status.apiProvider,";
const replacement = `    if (status.loggedIn === true && status.authMethod === "oauth_token" &&
        !externalBackend && !status.apiKeySource && !status.subscriptionType) {
        return { kind: "account", label: "Claude Code OAuth token" };
    }
${marker}`;

// The hash parameter is a test seam for small fixtures. Production always uses
// the published artifact hash; unknown/new source is never rewritten.
export function patchClaudeAuthStatus(source, expectedHash = CLAUDE_AUTH_STATUS_SHA256) {
  const text = typeof source === "string" ? source : Buffer.from(source).toString("utf8");
  if (createHash("sha256").update(text).digest("hex") !== expectedHash || !text.includes(marker)) return source;
  return text.replace(marker, replacement);
}

export function registerClaudeAuthCompatibility(entry = process.argv[1]) {
  if (!entry || path.basename(entry) !== "index.js" || path.basename(path.dirname(entry)) !== "dist") return;
  let pkg;
  try { pkg = JSON.parse(readFileSync(path.resolve(path.dirname(entry), "../package.json"), "utf8")); } catch { return; }
  if (pkg.name !== "@agentclientprotocol/claude-agent-acp" || !CLAUDE_COMPAT_VERSIONS.has(pkg.version)) return;
  const target = pathToFileURL(path.join(path.dirname(entry), "auth-status.js")).href;
  // Electron's bundled Node supports synchronous ESM hooks. The hook is local
  // to this adapter process and touches neither its files nor the credential store.
  nodeModule.registerHooks({
    load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      if (url !== target || result.source == null) return result;
      return { ...result, source: patchClaudeAuthStatus(result.source) };
    },
  });
}

registerClaudeAuthCompatibility();
