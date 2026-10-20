import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { CACHE_DIRECTORY, FORK_TESTS, checkSteps, parseCheckArguments } from "./fork-check.mjs";

const root = join(import.meta.dir, "..");

describe("fork local checks", () => {
  test("runs the fork tests and the repository's own typechecks, adding build:web only when asked", () => {
    expect(checkSteps({ full: false }).map((step) => step.args.slice(0, 2))).toEqual([
      ["test", FORK_TESTS[0]],
      ["run", "typecheck"],
      ["run", "typecheck:mobile"],
    ]);
    expect(checkSteps({ full: true }).at(-1)).toEqual({ label: "build:web", args: ["run", "build:web"] });
  });

  test("keeps each typecheck's incremental state in its own file under node_modules", () => {
    const files = checkSteps({ full: false })
      .filter((step) => step.label.startsWith("typecheck"))
      .map((step) => step.args[step.args.indexOf("--tsBuildInfoFile") + 1]);
    expect(new Set(files).size).toBe(2);
    for (const file of files) expect(file.startsWith(CACHE_DIRECTORY)).toBe(true);
    expect(CACHE_DIRECTORY.startsWith(join(root, "node_modules"))).toBe(true);
  });

  test("lists only existing test files, including its own", () => {
    for (const file of FORK_TESTS) expect(existsSync(join(root, file))).toBe(true);
    expect(FORK_TESTS).toContain("scripts/fork-check.test.mjs");
    expect(FORK_TESTS[0]).toBe("scripts/fork-invariants.test.mjs");
  });

  test("runs the same fork tests as fork-ci", () => {
    const ci = readFileSync(join(root, ".github/workflows/fork-ci.yml"), "utf8");
    const checks = ci.slice(ci.indexOf("  checks:"), ci.indexOf("  regression:"));
    const listed = [...checks.matchAll(/[\w./-]+\.test\.mjs/g)].map((match) => match[0]);
    expect([...listed].sort()).toEqual([...FORK_TESTS].sort());
  });

  test("accepts only --full", () => {
    expect(parseCheckArguments([])).toEqual({ full: false });
    expect(parseCheckArguments(["--full"])).toEqual({ full: true });
    expect(() => parseCheckArguments(["--quick"])).toThrow("Unknown option: --quick");
  });
});
