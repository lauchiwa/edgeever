import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAcpHostRuntime, createAcpSpawnPlan, detectInstalledAgentApps, removeAcpWorkspace, resolveAcpCommand } from "./acp-host.mjs";

async function withPrefix(run) {
  const root = await mkdtemp(path.join(tmpdir(), "edgeever-acp-npm-"));
  const prefix = path.join(root, "mise npm & tools");
  await mkdir(prefix);
  const deps = { platform: "win32", pathEnv: prefix, home: root, sep: path.sep, delimiter: path.delimiter, executablePath: process.execPath };
  try { await run({ root, prefix, deps }); } finally { await rm(root, { recursive: true, force: true }); }
}

async function writeShim(prefix, name, target = `node_modules/${name}/dist/index.js`) {
  const entry = path.resolve(prefix, target);
  await mkdir(path.dirname(entry), { recursive: true });
  // Executable mode: these Windows-semantics tests also run on Linux CI, where
  // the X_OK check needs it (Windows ignores the bits).
  await writeFile(entry, "process.stdout.write('fixture');\n", { mode: 0o755 });
  await writeFile(path.join(prefix, `${name}.cmd`), `@ECHO off\r\n@\"%~dp0\\node.exe\" \"%~dp0\\${target.replace(/\//g, "\\")}\" %*\r\n`, { mode: 0o755 });
  return realpathSync(entry);
}

test("resolves pi and its npm ACP connector in a custom mise/global prefix without a shell", async () => {
  await withPrefix(async ({ prefix, deps, root }) => {
    await writeShim(prefix, "pi");
    const adapter = await writeShim(prefix, "pi-acp");
    const result = resolveAcpCommand({ id: "piAgent" }, deps);
    expect(result).toEqual({ ok: true, command: { command: process.execPath, args: [adapter], env: { ELECTRON_RUN_AS_NODE: "1" } } });
    expect(detectInstalledAgentApps({ platform: "win32", pathEnv: prefix, home: root })).toContain("piAgent");
    const plan = createAcpSpawnPlan(result.command, root);
    expect(plan.options.shell).toBe(false);
    expect(plan.args).toEqual([adapter]);
  });
});

test("distinguishes an installed npm pi from a missing pi-acp and allows managed installation", async () => {
  await withPrefix(async ({ prefix, deps }) => {
    await writeShim(prefix, "pi");
    expect(resolveAcpCommand({ id: "piAgent" }, deps)).toMatchObject({ state: "not_installed", detail: "adapter_missing" });
    const installed = [];
    const runtime = createAcpHostRuntime({ ...deps, adapterManager: {
      get: () => null,
      install: async (id) => { installed.push(id); return { updated: true }; },
    } });
    expect(await runtime.installAdapter("piAgent")).toEqual({ updated: true });
    expect(installed).toEqual(["piAgent"]);
  });
});

test("resolves a global npm Claude ACP entry rather than spawning its .cmd file", async () => {
  await withPrefix(async ({ prefix, deps }) => {
    const entry = await writeShim(prefix, "claude-agent-acp", "node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js");
    const command = resolveAcpCommand({ id: "claudeCode" }, deps).command;
    expect(command.args.at(-1)).toBe(entry);
    expect(command.args.slice(0, 2)).toEqual(["--import", new URL("./claude-acp-compat.mjs", import.meta.url).href]);
  });
});

test("prefers native executables when both native and npm launchers are present", async () => {
  await withPrefix(async ({ prefix, deps }) => {
    await writeShim(prefix, "pi");
    await writeShim(prefix, "pi-acp");
    await writeFile(path.join(prefix, "pi-acp.exe"), "native-fixture", { mode: 0o755 });
    expect(resolveAcpCommand({ id: "piAgent" }, deps).command).toEqual({
      command: realpathSync(path.join(prefix, "pi-acp.exe")), args: [],
    });
  });
});

test("rejects arbitrary batch scripts, escaping targets, missing targets and non-JS shims", async () => {
  await withPrefix(async ({ prefix, deps }) => {
    const launcher = path.join(prefix, "pi.cmd");
    // Executable, so each case is rejected by the shim checks, not by X_OK on Linux.
    await writeFile(launcher, "", { mode: 0o755 });
    for (const target of ["../outside.js", "node_modules/pkg/../../outside.js", "node_modules/%INJECT%/main.js", "node_modules/pkg/main.py"]) {
      await writeFile(launcher, `@node \"%~dp0\\${target.replace(/\//g, "\\")}\" %*\r\n`);
      expect(resolveAcpCommand({ id: "piAgent" }, deps).state).toBe("not_installed");
    }
    await writeFile(launcher, "@node arbitrary.js & something-else\r\n");
    expect(resolveAcpCommand({ id: "piAgent" }, deps).state).toBe("not_installed");
    await writeFile(launcher, '@node "%~dp0\\node_modules\\missing\\index.js" %*\r\n');
    expect(resolveAcpCommand({ id: "piAgent" }, deps).state).toBe("not_installed");
  });
});

test("cleanup retries and defers a busy workspace instead of rejecting the connection result", async () => {
  const directory = path.join(tmpdir(), "edgeever-acp-cleanup-fixture");
  let deferred;
  let calls = 0;
  const busy = async (actual, flags) => {
    expect(actual).toBe(directory);
    expect(flags).toMatchObject({ recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    if (++calls === 1) throw Object.assign(new Error("busy"), { code: "EBUSY" });
  };
  expect(await removeAcpWorkspace(directory, busy, { schedule(fn, delay) {
    expect(delay).toBe(30000);
    deferred = fn;
    return { unref() {} };
  } })).toBe(false);
  deferred();
  await Promise.resolve();
  expect(calls).toBe(2);
});

test("cleanup never hides authentication failures and never deletes a non-workspace", async () => {
  const directory = path.join(tmpdir(), "edgeever-acp-cleanup-fixture");
  const denied = async () => { throw Object.assign(new Error("cleanup denied"), { code: "EACCES" }); };
  expect(await removeAcpWorkspace(directory, denied)).toBe(false);
  let removed = false;
  await removeAcpWorkspace(path.join(tmpdir(), "unrelated"), async () => { removed = true; });
  expect(removed).toBe(false);
});
