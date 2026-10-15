import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { applyForkVersion, nextForkTag, parseForkTag } from "./fork-release-version.mjs";

describe("fork release versions", () => {
  test("the first release of an upstream version is rc.0, then counts up numerically", () => {
    expect(nextForkTag("1.119.0", ["v1.118.0", "v1.119.0"])).toBe("v1.119.0-rc.0");
    expect(nextForkTag("1.119.0", ["v1.119.0-rc.0", "v1.119.0-rc.1"])).toBe("v1.119.0-rc.2");
    expect(nextForkTag("1.119.0", Array.from({ length: 10 }, (_, n) => `v1.119.0-rc.${n}`))).toBe("v1.119.0-rc.10");
  });

  test("a new upstream version starts again at rc.0", () => {
    expect(nextForkTag("1.120.0", ["v1.119.0-rc.4"])).toBe("v1.120.0-rc.0");
  });

  test("refuses a base below an already released fork version", () => {
    expect(() => nextForkTag("1.118.0", ["v1.119.0-rc.0"])).toThrow("never be offered");
  });

  test("a bare upstream version is refused, and says why", () => {
    expect(() => parseForkTag("v1.119.0")).toThrow("bare upstream version");
    for (const bad of ["1.119.0-rc.0", "v1.119.0-beta.1", "v1.119.0-rc.01", "v1.119.0-rc.1a"]) {
      expect(() => parseForkTag(bad)).toThrow();
    }
    expect(parseForkTag("v1.119.0-rc.3")).toMatchObject({ version: "1.119.0-rc.3", base: "1.119.0", n: 3 });
  });

  test("apply writes the tag version only over the matching upstream base", async () => {
    const root = await mkdtemp(join(tmpdir(), "edgeever-fork-version-"));
    try {
      await mkdir(join(root, "apps", "desktop"), { recursive: true });
      for (const file of ["package.json", "apps/desktop/package.json", "release-summary.json"]) {
        await writeFile(join(root, file), `{\n  "name": "x",\n  "version": "1.119.0",\n  "private": true\n}\n`);
      }
      expect(() => applyForkVersion("v1.120.0-rc.0", { root })).toThrow("must be built from upstream base");
      expect(applyForkVersion("v1.119.0-rc.1", { root })).toBe("1.119.0-rc.1");
      for (const file of ["package.json", "apps/desktop/package.json", "release-summary.json"]) {
        expect(await readFile(join(root, file), "utf8"))
          .toBe(`{\n  "name": "x",\n  "version": "1.119.0-rc.1",\n  "private": true\n}\n`);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
