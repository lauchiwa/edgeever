// Opt-in Windows verification with real npm packages and an installed previous
// adapter manager. Run using Electron with ELECTRON_RUN_AS_NODE=1:
//   EdgeEver.exe scripts/verify-acp-windows.mjs <previous app.asar/src/main/acp-adapter-manager.mjs>
// Uses a disposable store; never authenticates, sends prompts, or accesses notes.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createPackage } from "@electron/asar";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createAcpHostRuntime } from "../apps/desktop/src/main/acp-host.mjs";
import { createAcpAdapterManager } from "../apps/desktop/src/main/acp-adapter-manager.mjs";
import { patchClaudeAuthStatus } from "../apps/desktop/src/main/claude-acp-compat.mjs";

export async function verifyPackagedClaudeLoader(root, authSource, executablePath = process.execPath) {
  const loaderRoot = path.join(root, "loader");
  const fixtureRoot = path.join(root, "claude-fixture");
  await mkdir(loaderRoot, { recursive: true });
  await mkdir(path.join(fixtureRoot, "dist"), { recursive: true });
  await writeFile(path.join(loaderRoot, "claude-acp-compat.mjs"), await readFile(new URL("../apps/desktop/src/main/claude-acp-compat.mjs", import.meta.url)));
  await writeFile(path.join(fixtureRoot, "package.json"), JSON.stringify({ name: "@agentclientprotocol/claude-agent-acp", version: "0.90.0", type: "module" }));
  await writeFile(path.join(fixtureRoot, "dist/auth-status.js"), authSource);
  await writeFile(path.join(fixtureRoot, "dist/index.js"), `import {fromCliStatus} from './auth-status.js';
    console.log(JSON.stringify(fromCliStatus(JSON.stringify({loggedIn:true,authMethod:'oauth_token',apiProvider:'firstParty'}))));`);
  const archive = path.join(root, "loader.asar");
  await createPackage(loaderRoot, archive);
  const { stdout } = await promisify(execFile)(executablePath, ["--import", pathToFileURL(path.join(archive, "claude-acp-compat.mjs")).href, path.join(fixtureRoot, "dist/index.js")], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, windowsHide: true, timeout: 15000,
  });
  assert.deepEqual(JSON.parse(stdout), { kind: "account", label: "Claude Code OAuth token" });
  assert.equal(await readFile(path.join(fixtureRoot, "dist/auth-status.js"), "utf8"), authSource);
  console.log("Claude compatibility loader also passed from inside an ASAR archive.");
}

export async function verifyWindowsAcp(previousManagerPath) {
  assert.equal(process.platform, "win32");
  assert.ok(previousManagerPath, "Provide the previous installed adapter manager path");
  const previous = await import(pathToFileURL(path.resolve(previousManagerPath)).href);
  const root = await mkdtemp(path.join(tmpdir(), "edgeever-acp-upgrade-"));
  const tmpRoot = path.join(root, "sessions");
  await mkdir(tmpRoot);
  let codexVersion = "2.2.1";
  const common = {
    root: path.join(root, "store"), executablePath: process.execPath,
    fetchImpl: async (url) => new Response(JSON.stringify(url.includes("pi-acp")
      ? { name: "pi-acp", version: "0.0.34", bin: { "pi-acp": "dist/index.js" } }
      : { agents: [
        { id: "codex-acp", version: codexVersion, distribution: { npx: { package: `@agentclientprotocol/codex-acp@${codexVersion}` } } },
        { id: "claude-acp", version: "0.90.0", distribution: { npx: { package: "@agentclientprotocol/claude-agent-acp@0.90.0" } } },
      ] })),
  };
  const probe = (command, id) => createAcpHostRuntime({
    tmpRoot, handshakeTimeoutMs: 90000,
    adapterManager: { get: () => ({ command }) },
  }).probeAdapter({ id });
  const valid = (id) => async (command) => {
    const result = await probe(command, id);
    assert.ok(["available", "needs_login"].includes(result.state), `${id}: ${JSON.stringify(result)}`);
    return result;
  };
  try {
    const old = previous.createAcpAdapterManager(common);
    // The previous manager has no Windows rename retries. Let its real probe
    // handles settle while preparing the baseline, rather than modifying that
    // manager. All current-version activation below runs without this delay.
    const oldValidation = (id) => async (command) => {
      const result = await valid(id)(command);
      await delay(2000);
      return result;
    };
    await old.install("codex", oldValidation("codex"));
    await old.install("claudeCode", oldValidation("claudeCode"));
    const manifest = await readFile(path.join(common.root, "installed.json"), "utf8");
    const current = createAcpAdapterManager(common);
    assert.equal(current.get("codex").version, "2.2.1");
    assert.equal(current.get("claudeCode").version, "0.90.0");
    assert.equal(await readFile(path.join(common.root, "installed.json"), "utf8"), manifest);
    console.log("Previous manager installed real Codex 2.2.1 and Claude 0.90.0; current manager reads the unchanged manifest.");

    codexVersion = "2.2.2";
    await assert.rejects(current.install("codex", async (command) => {
      await valid("codex")(command);
      throw new Error("intentional_validation_failure");
    }, { updateOnly: true }), /intentional_validation_failure/);
    assert.equal(current.get("codex").version, "2.2.1");
    await valid("codex")(current.get("codex").command);
    const runtime = createAcpHostRuntime({ tmpRoot, handshakeTimeoutMs: 90000, adapterManager: current });
    assert.equal((await runtime.installAdapter("codex", { updateOnly: true })).version, "2.2.2");
    console.log("Failed real upgrade retained the old Codex; retry upgraded 2.2.1 -> 2.2.2.");

    const claudeEntry = current.get("claudeCode").command.args.at(-1);
    const authFile = path.join(path.dirname(claudeEntry), "auth-status.js");
    const original = await readFile(authFile, "utf8");
    const fixed = patchClaudeAuthStatus(original);
    assert.notEqual(fixed, original, "The published source must match the pinned compatibility hash");
    const fixture = JSON.stringify({ loggedIn: true, authMethod: "oauth_token", apiProvider: "firstParty" });
    const originalModule = await import(pathToFileURL(authFile).href);
    const fixedModule = await import(`data:text/javascript;base64,${Buffer.from(fixed).toString("base64")}`);
    assert.equal(originalModule.fromCliStatus(fixture).kind, "none");
    assert.equal(fixedModule.fromCliStatus(fixture).kind, "account");
    assert.equal(fixedModule.fromCliStatus(JSON.stringify({ loggedIn: false, apiProvider: "firstParty" })).kind, "none");
    assert.equal(await readFile(authFile, "utf8"), original);
    console.log("Real Claude 0.90.0 mapping regression verified; logged-out behavior and package bytes unchanged.");
    await verifyPackagedClaudeLoader(root, original);

    await runtime.installAdapter("piAgent");
    const restarted = createAcpHostRuntime({ tmpRoot, handshakeTimeoutMs: 90000, adapterManager: createAcpAdapterManager(common) });
    const results = [];
    for (const id of ["codex", "claudeCode", "piAgent"]) {
      const result = await restarted.probeAdapter({ id });
      assert.ok(["available", "needs_login"].includes(result.state), `${id}: ${JSON.stringify(result)}`);
      results.push({ id, state: result.state, version: result.version });
    }
    await current.prune();
    console.log(JSON.stringify({ results, promptsSent: 0 }));
    return results;
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await verifyWindowsAcp(process.argv[2]);
}
