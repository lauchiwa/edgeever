// Real old-to-new automatic update of a staged fork Linux release, run by
// fork-release.yml under xvfb (see docs/fork-releases.md):
//
//   bun scripts/fork-verify-linux-appimage-update.mjs <old.AppImage> <stage> <X.Y.Z-rc.N>
//
// The old AppImage runs in the desktop app's Linux update test mode, checks a
// loopback feed serving only the staged assets, downloads the new AppImage,
// replaces itself and relaunches as the new version, which then finds no
// further update and quits. Afterwards the old path must hold the staged bytes.
//
// Upstream's verify-linux-appimage-update.mjs only accepts stable versions and
// latest-linux.yml, so the fork keeps its own copy instead of editing it.
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LINUX_UPDATE_CHANNEL_FILE, linuxAppImageName, verifyLinuxRelease } from "./fork-linux-release.mjs";

const [oldAppImageInput, stageInput, expectedVersion] = process.argv.slice(2);
const oldAppImage = resolve(oldAppImageInput || "");
const stage = resolve(stageInput || "");
if (!existsSync(oldAppImage) || !statSync(oldAppImage).isFile()) throw new Error(`Old AppImage is missing: ${oldAppImage}`);
const { file } = verifyLinuxRelease(stage, expectedVersion);
const newAppImage = join(stage, linuxAppImageName(expectedVersion));

// In production the GitHub provider asks for rc-linux.yml. The test feed uses
// the generic provider, which asks for the default latest-linux.yml, so both
// names serve the same staged channel file.
const served = new Map([
  [file.name, newAppImage],
  [LINUX_UPDATE_CHANNEL_FILE, join(stage, LINUX_UPDATE_CHANNEL_FILE)],
  ["latest-linux.yml", join(stage, LINUX_UPDATE_CHANNEL_FILE)],
]);
const requests = [];
let appImageServed = false;
const server = createServer((request, response) => {
  const name = decodeURIComponent(new URL(request.url || "/", "http://127.0.0.1").pathname.slice(1));
  requests.push(name);
  const path = served.get(name);
  if (!path) {
    response.writeHead(404).end();
    return;
  }
  const size = statSync(path).size;
  response.writeHead(200, {
    "Accept-Ranges": "bytes",
    "Content-Length": size,
    "Content-Type": name.endsWith(".yml") ? "text/yaml" : "application/octet-stream",
  });
  if (path === newAppImage) response.once("finish", () => { appImageServed = true; });
  createReadStream(path).pipe(response);
});
await new Promise((resolveListen, rejectListen) => {
  server.once("error", rejectListen);
  server.listen(0, "127.0.0.1", resolveListen);
});

const testDirectory = mkdtempSync(join(tmpdir(), "edgeever-fork-linux-update-"));
const logPath = join(testDirectory, "logs", "desktop.log");
const output = [];
const child = spawn(oldAppImage, [], {
  env: {
    ...process.env,
    EDGE_EVER_DESKTOP_UPDATE_TEST: "1",
    EDGE_EVER_DESKTOP_UPDATE_TEST_FEED_URL: `http://127.0.0.1:${server.address().port}/`,
    EDGE_EVER_DESKTOP_UPDATE_TEST_USER_DATA: testDirectory,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (chunk) => output.push(chunk.toString()));
child.stderr.on("data", (chunk) => output.push(chunk.toString()));

const entries = () => {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8").split(/\r?\n/).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
};
const digest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const wait = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));

try {
  const deadline = Date.now() + 180_000;
  let passed = false;
  while (Date.now() < deadline) {
    const events = entries();
    const startedVersions = events.filter((entry) => entry.event === "update.test-started").map((entry) => entry.version);
    if (
      startedVersions[0] && startedVersions[0] !== expectedVersion
      && startedVersions.includes(expectedVersion)
      && events.some((entry) => entry.event === "update.downloaded" && entry.version === expectedVersion)
      && events.some((entry) => entry.event === "update.not-available")
    ) {
      if (!appImageServed) throw new Error("The new AppImage was never downloaded from the test feed");
      if (digest(oldAppImage) !== file.sha256) throw new Error("The installed AppImage does not match the staged release AppImage");
      process.stdout.write(`${JSON.stringify({ ok: true, from: startedVersions[0], to: expectedVersion, requests: [...new Set(requests)] })}\n`);
      passed = true;
      break;
    }
    await wait(200);
  }
  if (!passed) {
    throw new Error([
      "Linux AppImage did not complete the old-to-new automatic update.",
      `Feed requests: ${requests.join(", ") || "none"}`,
      existsSync(logPath) && `Diagnostic log:\n${readFileSync(logPath, "utf8")}`,
      output.length > 0 && `Process output:\n${output.join("")}`,
    ].filter(Boolean).join("\n\n"));
  }
} finally {
  server.close();
  if (child.exitCode === null) child.kill("SIGTERM");
  await rm(testDirectory, { recursive: true, force: true });
}
