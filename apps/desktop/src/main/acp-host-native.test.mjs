import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAcpHostRuntime, handshakeTimeoutFor } from "./acp-host.mjs";
import { createAcpAdapterManager } from "./acp-adapter-manager.mjs";

const fixture = (failure = null) => `
const readline = require('node:readline');
readline.createInterface({input:process.stdin}).on('line', line => {
  const m=JSON.parse(line);
  let result;
  if(m.method==='initialize') result={protocolVersion:1,agentCapabilities:{},authMethods:[]};
  else if(m.method==='session/new') {
    if(${JSON.stringify(failure)}) {
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:${failure === "auth_required" ? -32000 : -32603},message:${JSON.stringify(failure)}}})+'\\n');
      return;
    }
    result={sessionId:'fixture'};
  } else return;
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
});
`;

async function setup(run) {
  const root = await mkdtemp(path.join(tmpdir(), "edgeever-acp-native-test-"));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}

for (const failure of [null, "auth_required", "fixture_connection_failure"]) {
  test(`native probe preserves ${failure ?? "available"} despite busy-directory cleanup`, async () => {
    await setup(async (root) => {
      const script = path.join(root, "fixture.cjs");
      await writeFile(script, fixture(failure));
      const children = [];
      const diagnostics = [];
      const runtime = createAcpHostRuntime({
        tmpRoot: root,
        adapterManager: { get: () => ({ version: "2.2.2", command: { command: process.execPath, args: [script] } }) },
        spawnImpl(command, args, options) {
          expect(options.shell).toBe(false);
          const child = spawn(command, args, options);
          children.push(child);
          return child;
        },
        onDiagnostic: (event) => diagnostics.push(event),
        rm: async () => {
          expect(children.every(child => child.exitCode != null || child.signalCode != null)).toBe(true);
          throw Object.assign(new Error("private-path-must-not-leak"), { code: "EBUSY" });
        },
      });
      const result = await runtime.probeAdapter({ id: "codex" });
      expect(result.state).toBe(failure === null ? "available" : failure === "auth_required" ? "needs_login" : "failed");
      if (failure === "fixture_connection_failure") expect(result.detail).toBe(failure);
      expect(diagnostics.some(event => event.message === "workspace_cleanup_deferred (EBUSY)")).toBe(true);
      expect(JSON.stringify(diagnostics)).not.toContain("private-path");
    });
  }, 10000);
}

test("native install/update validation preserves the old manifest on failure and can retry", async () => {
  await setup(async (root) => {
    let version = "2.2.1";
    let failure = null;
    const store = path.join(root, "adapters");
    const options = {
      root: store,
      executablePath: process.execPath,
      fetchImpl: async () => new Response(JSON.stringify({ agents: [{ id: "codex-acp", version, distribution: { npx: { package: `@agentclientprotocol/codex-acp@${version}` } } }] })),
      installNpmImpl: async (_args, stage) => {
        const dir = path.join(stage, "node_modules/@agentclientprotocol/codex-acp/dist");
        await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, "index.js"), fixture(failure));
      },
    };
    const manager = createAcpAdapterManager(options);
    const runtime = createAcpHostRuntime({ tmpRoot: root, adapterManager: manager });
    expect((await runtime.installAdapter("codex")).version).toBe("2.2.1");
    version = "2.2.2";
    failure = "fixture_connection_failure";
    await expect(runtime.installAdapter("codex", { updateOnly: true })).rejects.toThrow(failure);
    expect(createAcpAdapterManager(options).get("codex").version).toBe("2.2.1");
    expect((await runtime.probeAdapter({ id: "codex" })).state).toBe("available");
    failure = null;
    expect((await runtime.installAdapter("codex", { updateOnly: true })).version).toBe("2.2.2");
    const restarted = createAcpHostRuntime({ tmpRoot: root, adapterManager: createAcpAdapterManager(options) });
    expect((await restarted.probeAdapter({ id: "codex" })).state).toBe("available");
  });
}, 20000);

test("Claude Code gets a longer connection budget; other adapters and explicit overrides are unchanged", () => {
  expect(handshakeTimeoutFor("claudeCode")).toBe(60_000);
  for (const id of ["codex", "piAgent", "workbuddyCn", "unknown"]) expect(handshakeTimeoutFor(id)).toBe(20_000);
  expect(handshakeTimeoutFor("claudeCode", 1_500)).toBe(1_500);
  expect(handshakeTimeoutFor("codex", 1_500)).toBe(1_500);
});

test("every connection attempt passes an explicit timeout", async () => {
  // withHandshakeTimeout has no default: a call without one would abort at once.
  const source = await readFile(new URL("./acp-host.mjs", import.meta.url), "utf8");
  const calls = source.split("await withHandshakeTimeout(").slice(1);
  expect(calls.length).toBe(5);
  for (const call of calls) {
    let depth = 1;
    let end = 0;
    while (depth > 0 && end < call.length) {
      const char = call[end++];
      if (char === "(") depth++;
      else if (char === ")") depth--;
    }
    expect(call.slice(0, end - 1)).toMatch(/,\s*(adapterTimeout\([^)]*\)|authenticationTimeoutMs|\d[\d_]*)\s*$/);
  }
});
