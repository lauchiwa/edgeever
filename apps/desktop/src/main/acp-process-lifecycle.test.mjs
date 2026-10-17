import { describe, expect, test } from "bun:test";
import { EventEmitter, once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { stopAcpChild, stopAcpChildSync, trackAcpChildClosure } from "./acp-process-lifecycle.mjs";

const fakeChild = () => Object.assign(new EventEmitter(), {
  pid: 12345, exitCode: null, signalCode: null,
  stdin: { destroy() {} },
  kill(signal) { this.signalCode = signal; this.emit("exit", null, signal); this.emit("close", null, signal); },
});

describe("ACP process lifecycle", () => {
  test("waits for both Windows tree termination and child close, before stdin EOF", async () => {
    const child = fakeChild();
    const order = [];
    child.stdin.destroy = () => order.push("stdin");
    let complete;
    const options = { platform: "win32", execFileImpl(command, args, flags, callback) {
      order.push("taskkill");
      expect(path.win32.basename(command)).toBe("taskkill.exe");
      expect(path.win32.isAbsolute(command)).toBe(true);
      expect(args).toEqual(["/PID", "12345", "/T", "/F"]);
      expect(flags).toMatchObject({ shell: false, windowsHide: true });
      complete = callback;
    } };
    const stopped = stopAcpChild(child, options);
    expect(stopAcpChild(child, options)).toBe(stopped);
    expect(order).toEqual(["taskkill"]);
    let finished = false;
    void stopped.then(() => { finished = true; });
    child.signalCode = "SIGTERM";
    child.emit("exit");
    complete();
    await Promise.resolve();
    // A descendant can still hold the inherited pipes (and the cwd) after exit.
    expect(finished).toBe(false);
    child.emit("close");
    await stopped;
    expect(order).toEqual(["taskkill", "stdin"]);
    expect(child.listenerCount("close")).toBe(0);
  });

  test("never uses a stale PID after exit, including synchronous application shutdown", async () => {
    const child = fakeChild();
    child.exitCode = 0;
    child.kill = () => { throw new Error("must not kill"); };
    const unexpected = () => { throw new Error("must not spawn taskkill"); };
    const stopped = stopAcpChild(child, { platform: "win32", execFileImpl: unexpected });
    child.emit("close");
    await stopped;
    stopAcpChildSync(child, { platform: "win32", execFileSyncImpl: unexpected });
  });

  test("returns at once for a child that closed before the first stop request", async () => {
    const child = fakeChild();
    trackAcpChildClosure(child);
    child.exitCode = 0;
    child.emit("exit");
    child.emit("close");
    child.kill = () => { throw new Error("must not kill"); };
    await stopAcpChild(child, { platform: "win32", execFileImpl() { throw new Error("must not spawn"); }, timeoutMs: 60_000 });
  });

  test("bounds the wait when pipes never close", async () => {
    const child = fakeChild();
    child.kill = (signal) => { child.signalCode = signal; child.emit("exit"); };
    const started = Date.now();
    await stopAcpChild(child, { platform: "linux", graceMs: 10, timeoutMs: 50 });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(child.listenerCount("close")).toBe(0);
  });

  test("falls back to the owned process handle when taskkill cannot start", async () => {
    const child = fakeChild();
    await stopAcpChild(child, { platform: "win32", execFileImpl() { throw new Error("ENOENT"); } });
    expect(child.signalCode).toBe("SIGKILL");
  });

  test("rejects nonnumeric PID arguments instead of invoking a command", async () => {
    const child = fakeChild();
    child.pid = "1 & other-command";
    await stopAcpChild(child, { platform: "win32", execFileImpl() { throw new Error("must not spawn"); } });
    expect(child.signalCode).toBe("SIGTERM");
  });

  test("waits for POSIX graceful exit and escalates a stubborn child", async () => {
    const child = fakeChild();
    const signals = [];
    child.kill = (signal) => {
      signals.push(signal);
      if (signal === "SIGKILL") { child.signalCode = signal; child.emit("exit"); child.emit("close"); }
    };
    await stopAcpChild(child, { platform: "linux", graceMs: 10, timeoutMs: 100 });
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test.skipIf(process.platform !== "win32")("releases a real Windows child and grandchild working directory", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "edgeever-acp-tree-test-"));
    const source = `const {spawn}=require('node:child_process');
      const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{cwd:process.cwd(),stdio:'ignore'});
      child.once('spawn',()=>process.stdout.write('ready'));
      setInterval(()=>{},1000);`;
    const child = spawn(process.execPath, ["-e", source], { cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    try {
      await once(child.stdout, "data");
      await stopAcpChild(child);
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } finally {
      stopAcpChildSync(child);
      await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 10000);
});
