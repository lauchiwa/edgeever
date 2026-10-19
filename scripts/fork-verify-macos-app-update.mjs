// Real old-to-new automatic update of a signed fork macOS release, run by
// fork-release.yml's macos-verify job (see docs/fork-releases.md):
//
//   bun scripts/fork-verify-macos-app-update.mjs <predecessor.zip> <stage> <X.Y.Z-rc.N> <arm64|x64>
//
// The signed predecessor app runs in the desktop app's update test mode,
// checks a loopback feed serving only the staged assets, downloads the new zip
// and hands it to Squirrel.Mac, which accepts it only if it satisfies the
// running app's designated requirement. ShipIt then replaces the bundle in
// place and relaunches it. Afterwards the old path must hold the staged,
// signed app; the relaunched copy is stopped, since it no longer runs in test
// mode.
import { spawn, spawnSync } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  MAC_UPDATE_CHANNEL_FILE,
  checkMacSignature,
  extractMacApp,
  macZipName,
  plistValue,
  verifyMacRelease,
} from "./fork-macos-release.mjs";

const [predecessorInput, stageInput, expectedVersion, arch] = process.argv.slice(2);
const predecessorZip = resolve(predecessorInput || "");
const stage = resolve(stageInput || "");
if (!existsSync(predecessorZip) || !statSync(predecessorZip).isFile()) throw new Error(`Predecessor zip is missing: ${predecessorZip}`);
verifyMacRelease(stage, expectedVersion);
const newZipName = macZipName(expectedVersion, arch);
const newZip = join(stage, newZipName);

const testDirectory = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), "edgeever-fork-macos-update-"));
const { cdhash: stagedCdhash } = checkMacSignature(extractMacApp(newZip, join(testDirectory, "staged")), { version: expectedVersion, arch });
const app = extractMacApp(predecessorZip, join(testDirectory, "installed"));
const infoPlist = join(app, "Contents", "Info.plist");
const oldVersion = plistValue(infoPlist, "CFBundleShortVersionString");
if (oldVersion === expectedVersion) throw new Error(`The predecessor is already ${expectedVersion}`);
// The update is accepted only against the running app's requirement, so the
// predecessor must already carry the pinned one.
checkMacSignature(app, { version: oldVersion, arch });

// In production the GitHub provider asks for rc-mac.yml. The test feed uses
// the generic provider, which asks for the default latest-mac.yml, so both
// names serve the same staged channel file. Blockmaps are not published, so
// their 404 makes electron-updater download the full zip.
const served = new Map([
  [newZipName, newZip],
  [MAC_UPDATE_CHANNEL_FILE, join(stage, MAC_UPDATE_CHANNEL_FILE)],
  ["latest-mac.yml", join(stage, MAC_UPDATE_CHANNEL_FILE)],
]);
const requests = [];
let zipServed = false;
const server = createServer((request, response) => {
  const name = decodeURIComponent(new URL(request.url || "/", "http://127.0.0.1").pathname.slice(1));
  requests.push(name);
  const path = served.get(name);
  if (!path) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, {
    "Accept-Ranges": "bytes",
    "Content-Length": statSync(path).size,
    "Content-Type": name.endsWith(".yml") ? "text/yaml" : "application/zip",
  });
  if (path === newZip) response.once("finish", () => { zipServed = true; });
  createReadStream(path).pipe(response);
});
await new Promise((resolveListen, rejectListen) => {
  server.once("error", rejectListen);
  server.listen(0, "127.0.0.1", resolveListen);
});

const userData = join(testDirectory, "user-data");
const logPath = join(userData, "logs", "desktop.log");
// Skip the first-launch "installed successfully" dialog, which would hold
// startup (and the update check) until someone clicks it.
mkdirSync(userData, { recursive: true });
writeFileSync(join(userData, "installation-confirmed"), new Date().toISOString());

const output = [];
let oldProcessExited = false;
const child = spawn(join(app, "Contents", "MacOS", plistValue(infoPlist, "CFBundleExecutable")), [], {
  env: {
    ...process.env,
    EDGE_EVER_DESKTOP_UPDATE_TEST: "1",
    EDGE_EVER_DESKTOP_UPDATE_TEST_FEED_URL: `http://127.0.0.1:${server.address().port}/`,
    EDGE_EVER_DESKTOP_UPDATE_TEST_USER_DATA: userData,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
child.once("exit", () => { oldProcessExited = true; });
child.stdout.on("data", (chunk) => output.push(chunk.toString()));
child.stderr.on("data", (chunk) => output.push(chunk.toString()));

const entries = () => {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8").split(/\r?\n/).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
};
const wait = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
const installedVersion = () => {
  try { return plistValue(infoPlist, "CFBundleShortVersionString"); } catch { return null; }
};
// The relaunched app (and anything else) running from the test bundle.
const stopBundleProcesses = () => {
  const listing = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).stdout || "";
  for (const line of listing.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match && match[2].startsWith(`${app}/`)) {
      try { process.kill(Number(match[1]), "SIGTERM"); } catch {}
    }
  }
};
const shipItLog = join(homedir(), "Library", "Caches", "org.edgeever.desktop.ShipIt", "ShipIt_stderr.log");

try {
  const deadline = Date.now() + 300_000;
  let passed = false;
  while (Date.now() < deadline) {
    const events = entries();
    const failure = events.find((entry) => entry.event === "update.error" || entry.event === "update.download-handler-failed");
    if (failure) throw new Error(`The predecessor reported ${failure.event}: ${failure.message}`);
    if (
      events.some((entry) => entry.event === "update.test-started" && entry.version === oldVersion)
      && events.some((entry) => entry.event === "update.downloaded" && entry.version === expectedVersion)
      && oldProcessExited
      && installedVersion() === expectedVersion
    ) {
      if (!zipServed) throw new Error("The new zip was never downloaded from the test feed");
      // ShipIt may still be settling the bundle; the signature must end up exact.
      let installed = null;
      for (let attempt = 1; attempt <= 10 && !installed; attempt += 1) {
        try { installed = checkMacSignature(app, { version: expectedVersion, arch }); }
        catch (error) { if (attempt === 10) throw error; await wait(1000); }
      }
      if (installed.cdhash !== stagedCdhash) throw new Error("The installed app does not match the staged release app");
      process.stdout.write(`${JSON.stringify({ ok: true, arch, from: oldVersion, to: expectedVersion, cdhash: installed.cdhash, requests: [...new Set(requests)] })}\n`);
      passed = true;
      break;
    }
    await wait(500);
  }
  if (!passed) {
    throw new Error([
      `macOS ${arch} did not complete the old-to-new automatic update.`,
      `Feed requests: ${requests.join(", ") || "none"}`,
      `Installed version: ${installedVersion()}; predecessor exited: ${oldProcessExited}`,
      existsSync(logPath) && `Diagnostic log:\n${readFileSync(logPath, "utf8")}`,
      existsSync(shipItLog) && `ShipIt log:\n${readFileSync(shipItLog, "utf8")}`,
      output.length > 0 && `Process output:\n${output.join("")}`,
    ].filter(Boolean).join("\n\n"));
  }
} finally {
  server.close();
  if (child.exitCode === null) child.kill("SIGTERM");
  stopBundleProcesses();
  await wait(1000);
  await rm(testDirectory, { recursive: true, force: true });
}
