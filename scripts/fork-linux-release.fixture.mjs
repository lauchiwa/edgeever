// Test fixture: what electron-builder leaves in release/desktop for an AppImage build.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { linuxAppImageName } from "./fork-linux-release.mjs";

export const writeLinuxBuild = (directory, version, content = "appimage payload") => {
  mkdirSync(directory, { recursive: true });
  const name = linuxAppImageName(version);
  const bytes = Buffer.from(content);
  const sha512 = createHash("sha512").update(bytes).digest("base64");
  writeFileSync(join(directory, name), bytes);
  writeFileSync(join(directory, "latest-linux.yml"), [
    `version: ${version}`,
    "files:",
    `  - url: ${name}`,
    `    sha512: ${sha512}`,
    `    size: ${bytes.length}`,
    "    blockMapSize: 123",
    `path: ${name}`,
    `sha512: ${sha512}`,
    "releaseDate: '2026-10-18T00:00:00.000Z'",
    "",
  ].join("\n"));
  writeFileSync(join(directory, "builder-debug.yml"), "unrelated\n");
};
