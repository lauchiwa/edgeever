import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { READ_DOCS, decideScope, isDocumentation } from "./fork-ci-scope.mjs";

const root = join(import.meta.dir, "..");
const MAIN = "a".repeat(40);
const HEAD = "b".repeat(40);
const pr = (files) => decideScope({ event: "pull_request", parents: [MAIN, HEAD], files });

describe("fork CI scope", () => {
  test("skips the checks only for documentation nothing reads", () => {
    expect(pr(["docs/fork-releases.md", "docs/fork-releases.zh-CN.md"]).run).toBe(false);
    expect(pr(["CONTRIBUTING.md"]).run).toBe(false);
    expect(pr(["docs/guides/nested.md"]).run).toBe(false);
  });

  test("runs every check for code, assets or documentation that is read", () => {
    for (const files of [
      ["apps/web/src/main.tsx"],
      ["docs/fork-releases.md", "scripts/fork-check.mjs"],
      ["docs/assets/best-practices/example.png"],
      ["docs/deploy-docker.md"],
      ["README.zh-CN.md"],
      ["AGENTS.md"],
      ["apps/ios/README.md"],
      [".github/workflows/fork-ci.yml"],
      ["docs/NOTES.MD"],
      ["docs/../package.md"],
    ]) expect(pr(files).run).toBe(true);
  });

  test("runs every check when it cannot tell what changed", () => {
    expect(decideScope({ event: "workflow_dispatch", parents: [MAIN, HEAD], files: ["docs/a.md"] }).run).toBe(true);
    expect(decideScope({ event: undefined, parents: [MAIN, HEAD], files: ["docs/a.md"] }).run).toBe(true);
    expect(decideScope({ event: "pull_request", parents: [MAIN], files: ["docs/a.md"] }).run).toBe(true);
    expect(decideScope({ event: "pull_request", parents: [MAIN, HEAD, HEAD], files: ["docs/a.md"] }).run).toBe(true);
    expect(pr([]).run).toBe(true);
    expect(decideScope({ event: "pull_request", parents: [MAIN, HEAD] }).run).toBe(true);
  });

  test("skips a push only when it is one merge commit onto the previous main", () => {
    const push = (before) => decideScope({ event: "push", parents: [MAIN, HEAD], before, files: ["docs/a.md"] });
    expect(push(MAIN).run).toBe(false);
    expect(push(HEAD).run).toBe(true);
    expect(push(undefined).run).toBe(true);
    expect(push("0".repeat(40)).run).toBe(true);
  });

  test("treats only Markdown under docs/ or at the root as documentation", () => {
    expect(isDocumentation("docs/a.md")).toBe(true);
    expect(isDocumentation("README.md")).toBe(true);
    expect(isDocumentation("apps/web/README.md")).toBe(false);
    expect(isDocumentation("docs/a.mdx")).toBe(false);
    expect(isDocumentation("docs/a.png")).toBe(false);
  });

  // A document is read when tracked code names it in a string literal, for
  // example an import, a file read or a URL to its raw content.
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  const documents = tracked.filter(isDocumentation);
  const sources = tracked.filter((file) => /\.(?:[cm]?[jt]sx?|astro|vue|json|html|sh)$/.test(file)
    && !file.startsWith("scripts/fork-ci-scope."));
  const literals = (text) => [...text.matchAll(/(["'`])([^"'`\n]*?\.md)(?:[?#][^"'`\n]*)?\1/g)].map((match) => match[2]);
  const texts = sources.flatMap((source) => {
    try { return [[source, readFileSync(join(root, source), "utf8")]]; } catch { return []; }
  });

  test("every document read by code or tests is listed, so changing it runs the checks", () => {
    const unlisted = new Map();
    for (const [source, text] of texts) {
      for (const literal of literals(text)) {
        const path = literal.replace(/\\/g, "/");
        for (const document of documents) {
          if (READ_DOCS.has(document)) continue;
          if (path === document || path.endsWith(`/${document}`)) unlisted.set(document, source);
        }
      }
    }
    expect(Object.fromEntries(unlisted)).toEqual({});
  });

  test("no code builds a documentation path at runtime, which the list could not see", () => {
    // `docs/${name}`, `README${suffix}.md` or join("docs", name): the document
    // name is computed. Note names such as `${title}.md` are user data, not docs.
    const computed = /`[^`\n]*(?:\bdocs\/[^`\n]*\$\{|README\$\{)[^`\n]*`|join\(\s*(?:[\w.]+,\s*)?["']docs["']\s*,/;
    expect(texts.filter(([, text]) => computed.test(text)).map(([source]) => source)).toEqual([]);
  });

  test("lists only tracked documents", () => {
    for (const document of READ_DOCS) expect(documents).toContain(document);
  });
});
