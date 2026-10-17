import { execFile, execFileSync } from "node:child_process";
import path from "node:path";

const stopping = new WeakMap();
const closed = new WeakSet();
const exited = (child) => child.exitCode != null || child.signalCode != null;
const validPid = (child) => Number.isSafeInteger(child.pid) && child.pid > 0;
const taskkillPath = () => path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");
const kill = (child, signal) => { try { child.kill(signal); } catch { /* already gone */ } };

// Record close from spawn time, so a child that closed before its first stop
// request is not awaited until the deadline.
export function trackAcpChildClosure(child) {
  child?.once?.("close", () => closed.add(child));
}

// exit only describes the direct process; descendants can keep inherited pipes
// (and on Windows the cwd) open until close, so cleanup waits for close.
// Keep Windows termination scoped to this still-live child and its descendants.
// Do this BEFORE closing stdin: an adapter may exit on EOF, leaving no parent
// for taskkill /T to find. Never kill by executable name or by a saved PID.
export function stopAcpChild(child, { platform = process.platform, execFileImpl = execFile, graceMs = 500, timeoutMs = 3000 } = {}) {
  if (!child) return Promise.resolve();
  if (stopping.has(child)) return stopping.get(child);
  if (closed.has(child)) return Promise.resolve();
  let finish;
  let graceTimer;
  let deadline;
  const wait = new Promise((resolve) => {
    const onClose = () => { closed.add(child); finish(); };
    finish = () => {
      clearTimeout(graceTimer);
      clearTimeout(deadline);
      child.removeListener?.("close", onClose);
      resolve();
    };
    child.once?.("close", onClose);
    // Bound the wait; workspace removal retries any lock that remains.
    deadline = setTimeout(finish, timeoutMs);
  });
  const closeInput = () => { try { child.stdin?.destroy(); } catch { /* closed */ } };
  let tree = Promise.resolve();
  if (exited(child)) {
    // Never signal or taskkill a stale PID; only wait for its pipes to close.
    closeInput();
  } else if (platform === "win32" && validPid(child)) {
    tree = new Promise((resolve) => {
      const complete = () => {
        closeInput();
        if (!exited(child)) kill(child, "SIGKILL");
        resolve();
      };
      try {
        execFileImpl(taskkillPath(), ["/PID", String(child.pid), "/T", "/F"], {
          windowsHide: true, shell: false, timeout: Math.min(2000, timeoutMs),
        }, complete);
      } catch { complete(); }
    });
  } else {
    graceTimer = setTimeout(() => { if (!exited(child)) kill(child, "SIGKILL"); }, graceMs);
    closeInput();
    kill(child, "SIGTERM");
  }
  const result = Promise.all([wait, tree]).then(() => {});
  stopping.set(child, result);
  return result;
}

// Node's exit event cannot await promises. Only live children retained by the
// ACP host reach this fallback; normal session teardown uses stopAcpChild.
export function stopAcpChildSync(child, { platform = process.platform, execFileSyncImpl = execFileSync } = {}) {
  if (!child || exited(child)) return;
  if (platform === "win32" && validPid(child)) {
    try {
      execFileSyncImpl(taskkillPath(), ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true, shell: false, timeout: 2000, stdio: "ignore",
      });
      return;
    } catch { /* Fall back to the owned child handle. */ }
  }
  kill(child, "SIGKILL");
}
