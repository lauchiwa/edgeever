import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  LINUX_CHECKSUM_FILE,
  LINUX_UPDATE_CHANNEL_FILE,
  linuxAppImageName,
  linuxReleaseAssetNames,
  stageLinuxRelease,
  verifyLinuxRelease,
} from "./fork-linux-release.mjs";
import { writeLinuxBuild } from "./fork-linux-release.fixture.mjs";

const VERSION = "1.122.0-rc.1";
const NAME = linuxAppImageName(VERSION);
let root;

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "edgeever-fork-linux-")); });
afterEach(() => rm(root, { recursive: true, force: true }));

const build = () => join(root, "build");
const stage = (stageName = "stage", version = VERSION) =>
  stageLinuxRelease({ buildDirectory: build(), stageDirectory: join(root, stageName), version });

describe("fork Linux release", () => {
  test("stages the AppImage, the rc channel file an rc client fetches, and the checksum list", () => {
    writeLinuxBuild(build(), VERSION);
    const result = stage();
    expect(LINUX_UPDATE_CHANNEL_FILE).toBe("rc-linux.yml");
    expect(linuxReleaseAssetNames(VERSION)).toEqual([NAME, "rc-linux.yml", "SHA256SUMS-linux.txt"]);
    expect(result).toMatchObject({ version: VERSION, file: { name: NAME, size: "appimage payload".length } });
    expect(readFileSync(join(root, "stage", LINUX_UPDATE_CHANNEL_FILE), "utf8"))
      .toBe(readFileSync(join(build(), "latest-linux.yml"), "utf8"));
    expect(readFileSync(join(root, "stage", LINUX_CHECKSUM_FILE), "utf8")).toBe(`${result.file.sha256}  ${NAME}\n`);
    expect(verifyLinuxRelease(join(root, "stage"), VERSION)).toEqual(result);
  });

  test("refuses bare or non-fork versions", () => {
    writeLinuxBuild(build(), "1.122.0");
    expect(() => stage("stage", "1.122.0")).toThrow("X.Y.Z-rc.N");
  });

  test("refuses builder metadata for another version or that selects another AppImage", () => {
    writeLinuxBuild(build(), VERSION);
    const path = join(build(), "latest-linux.yml");
    const metadata = readFileSync(path, "utf8");
    writeFileSync(path, metadata.replace(`version: ${VERSION}`, "version: 1.122.0-rc.0"));
    expect(() => stage("stage-version")).toThrow("not version");
    writeFileSync(path, metadata.replace("files:\n", "files:\n  - url: other.AppImage\n"));
    expect(() => stage("stage-extra")).toThrow("exactly");
  });

  test("an audit rejects a tampered AppImage, a missing block map, a wrong checksum or an extra file", () => {
    writeLinuxBuild(build(), VERSION);
    stage();
    const directory = join(root, "stage");
    const appImage = join(directory, NAME);
    const original = readFileSync(appImage);
    writeFileSync(appImage, "tampered payload");
    expect(() => verifyLinuxRelease(directory, VERSION)).toThrow("does not match");
    writeFileSync(appImage, original);

    const metadataPath = join(directory, LINUX_UPDATE_CHANNEL_FILE);
    const metadata = readFileSync(metadataPath, "utf8");
    writeFileSync(metadataPath, metadata.replace("blockMapSize: 123", "blockMapSize: 0"));
    expect(() => verifyLinuxRelease(directory, VERSION)).toThrow("block map");
    writeFileSync(metadataPath, metadata);

    const checksumPath = join(directory, LINUX_CHECKSUM_FILE);
    const checksum = readFileSync(checksumPath, "utf8");
    writeFileSync(checksumPath, `${"0".repeat(64)}  ${NAME}\n`);
    expect(() => verifyLinuxRelease(directory, VERSION)).toThrow(LINUX_CHECKSUM_FILE);
    writeFileSync(checksumPath, checksum);
    expect(verifyLinuxRelease(directory, VERSION).version).toBe(VERSION);

    writeFileSync(join(directory, "latest-linux.yml"), metadata);
    expect(() => verifyLinuxRelease(directory, VERSION)).toThrow("exactly");
  });
});
