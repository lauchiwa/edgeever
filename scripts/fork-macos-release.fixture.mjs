// Fake macOS release assets for tests that run on any platform: the zips and
// disk images only carry the magic bytes verifyMacRelease checks.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  MAC_ARCHES,
  MAC_CHECKSUM_FILE,
  MAC_UPDATE_CHANNEL_FILE,
  buildMacUpdateMetadata,
  macDmgName,
  macZipName,
} from "./fork-macos-release.mjs";

export const writeMacRelease = (directory, version, { releaseDate = "2026-01-02T03:04:05.000Z" } = {}) => {
  mkdirSync(directory, { recursive: true });
  const names = [];
  for (const arch of MAC_ARCHES) {
    writeFileSync(join(directory, macZipName(version, arch)), Buffer.concat([Buffer.from("PK\x03\x04", "latin1"), Buffer.from(`zip ${arch} ${version}`)]));
    writeFileSync(join(directory, macDmgName(version, arch)), Buffer.concat([Buffer.from(`dmg ${arch} ${version}`), Buffer.from("koly", "latin1"), Buffer.alloc(508)]));
    names.push(macZipName(version, arch), macDmgName(version, arch));
  }
  writeFileSync(join(directory, MAC_UPDATE_CHANNEL_FILE), buildMacUpdateMetadata({ directory, version, releaseDate }));
  writeFileSync(join(directory, MAC_CHECKSUM_FILE), names
    .map((name) => `${createHash("sha256").update(readFileSync(join(directory, name))).digest("hex")}  ${name}\n`).join(""));
};
