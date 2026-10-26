#!/usr/bin/env node
// Decides whether a fork-ci.yml job has to run its checks (see
// docs/fork-releases.md). Only a change made of Markdown documentation that no
// code, test or build reads is skipped; everything else runs every check.
//
//   node scripts/fork-ci-scope.mjs   writes run=true|false to $GITHUB_OUTPUT
//
// It fails closed: the workflow skips the checks only on an explicit
// run=false, so a crash, a missing output or any unknown case runs them all.
// Node built-ins only, so it can run before dependencies are installed.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Markdown under docs/ or at the repository root, and nothing else: no images,
// workflows, scripts or configuration.
export const isDocumentation = (file) => /^(?:docs\/[^\0]+|[^/]+)\.md$/.test(file) && !file.includes("..");

// Documents whose content code, tests or the build read (as an import, a file
// read or a fetched path). Changing one runs every check.
// scripts/fork-ci-scope.test.mjs fails when a read is missing from this list.
export const READ_DOCS = new Set([
  "AGENTS.md",
  "README.ja.md",
  "README.md",
  "README.pl-PL.md",
  "README.zh-CN.md",
  "README.zh-TW.md",
  "docs/agent-deploy-cloudflare.md",
  "docs/agent-deploy-cloudflare.zh-CN.md",
  "docs/best-practices.md",
  "docs/best-practices.zh-CN.md",
  "docs/deploy-cloudflare-button.md",
  "docs/deploy-cloudflare-button.zh-CN.md",
  "docs/deploy-docker.md",
  "docs/deploy-docker.zh-CN.md",
  "docs/evernote-migration-guide.en-US.md",
  "docs/evernote-migration-guide.md",
  "docs/manual-deploy.md",
  "docs/manual-deploy.zh-CN.md",
  "docs/plugin-development.md",
  "docs/plugin-development.zh-CN.md",
  "docs/self-hosting-architecture.md",
  "docs/self-hosting-architecture.zh-CN.md",
]);

const run = (reason) => ({ run: true, reason });

/**
 * event: GITHUB_EVENT_NAME. parents: parent commits of HEAD. before: the
 * previous main for a push. files: paths changed against the first parent.
 */
export const decideScope = ({ event, parents, before, files }) => {
  // pull_request checks out the merge of the head into main; every push to
  // main is the merge commit of a pull request (the ruleset allows only
  // merges). Either way the first parent is the main the change lands on.
  if (event !== "pull_request" && event !== "push") return run(`${event || "unknown"} event`);
  if (!Array.isArray(parents) || parents.length !== 2) return run("not a single merge commit");
  if (event === "push" && before !== parents[0]) return run("push is not one merge onto the previous main");
  if (!Array.isArray(files) || files.length === 0) return run("no changed files listed");
  const relevant = files.filter((file) => !isDocumentation(file) || READ_DOCS.has(file));
  if (relevant.length > 0) return run(`changes ${relevant.slice(0, 5).join(", ")}${relevant.length > 5 ? ", …" : ""}`);
  return { run: false, reason: `documentation only: ${files.join(", ")}` };
};

const git = (args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

export const currentScope = (env = process.env) => {
  const parents = git(["rev-list", "--parents", "-n", "1", "HEAD"]).split(/\s+/).slice(1);
  // --no-renames lists both sides of a rename, so moving a file out of docs/
  // or into a read document is seen as a change to it.
  const files = parents.length === 2
    ? git(["diff", "--name-only", "--no-renames", "-z", parents[0], "HEAD"]).split("\0").filter(Boolean)
    : [];
  return decideScope({ event: env.GITHUB_EVENT_NAME, parents, before: env.FORK_CI_BEFORE, files });
};

const main = () => {
  let scope;
  try {
    scope = currentScope();
  } catch (error) {
    scope = run(`scope check failed: ${error.message.split("\n")[0]}`);
  }
  process.stdout.write(`run=${scope.run} (${scope.reason})\n`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `run=${scope.run}\n`);
  if (process.env.GITHUB_STEP_SUMMARY && !scope.run) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Checks skipped: ${scope.reason}\n`);
  }
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
