import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../src/config";
import { run } from "../src/exec";
import { type Context, dryRun, push } from "../src/ops";
import { repoPaths } from "../src/paths";
import { AI_LINES, lineMatchers, stripPatterns, strippable } from "../src/strip";
import { commitAs, git, IDENTITY, OLD, sandbox } from "./helpers";

const config: Config = { owner: "me", identity: IDENTITY, oldEmails: OLD };
const TRAILER = "Claude-Session: https://claude.ai/code/session_x";

describe("stripPatterns", () => {
  it("should use the AI preset when the config lists no pattern", () => {
    expect(stripPatterns({})).toEqual(AI_LINES);
  });

  it("should remove nothing when the config lists an empty array", () => {
    expect(stripPatterns({ stripLines: [] })).toEqual([]);
  });

  it("should expand @ai next to a custom pattern", () => {
    expect(stripPatterns({ stripLines: ["^Internal:", "@ai"] })).toEqual([
      "^Internal:",
      ...AI_LINES,
    ]);
  });
});

describe("strippable", () => {
  const matchers = lineMatchers(AI_LINES);

  it("should count AI lines in the body when they follow the subject", () => {
    const message = `fix: x\n\nbody\n\n${TRAILER}\nCo-Authored-By: Claude\n`;
    expect(strippable(message, matchers)).toBe(2);
  });

  it("should not count the subject when it matches a pattern", () => {
    expect(strippable("Claude-Session: notes\n\nbody\n", matchers)).toBe(0);
  });

  it("should not count a human co-author when the line names no AI tool", () => {
    expect(strippable("feat: y\n\nCo-Authored-By: Ann Lee\n", matchers)).toBe(0);
  });
});

let root: string;
let work: string;
let remote: string;
let ctx: Context;
let logs: string[];

function messages(dir: string): string[] {
  return git(dir, ["log", "--all", "--format=%B%x1e"])
    .split("\u001e")
    .map((message) => message.replace(/^\n/, ""))
    .filter(Boolean);
}

beforeEach(() => {
  root = sandbox();
  work = join(root, "work");
  remote = join(root, "remote.git");
  git(root, ["init", "--quiet", work]);
  commitAs(work, "tester@example.com", "Claude-Session: kept as a subject");
  commitAs(work, "tester@example.com", `feat: add a thing\n\nWhy it matters.\n\n${TRAILER}`);
  commitAs(work, "tester@example.com", "fix: plain\n\nInternal: ticket 12");
  git(root, ["clone", "--quiet", "--bare", work, remote]);
  logs = [];
  ctx = { run, cache: join(root, "cache"), log: (line) => logs.push(line) };
});

describe("dry run with AI lines", () => {
  it("should remove an AI trailer and its blank line while keeping the subject and body", async () => {
    const result = await dryRun(ctx, config, "repo", remote);
    expect(result.before.lines).toBe(1);
    expect(result.left).toBe(0);
    const mirror = repoPaths(ctx.cache, "repo").mirror;
    expect(messages(mirror)).toContain("feat: add a thing\n\nWhy it matters.\n");
    expect(messages(mirror)).toContain("Claude-Session: kept as a subject\n");
    expect(logs.join("\n")).toMatch(/AI lines in messages: 1 before, 0 after/);
  });

  it("should keep untouched commits byte for byte when only a later one changes", async () => {
    const first = git(remote, ["rev-list", "--max-parents=0", "main"]).trim();
    await dryRun(ctx, config, "repo", remote);
    const mirror = repoPaths(ctx.cache, "repo").mirror;
    expect(git(mirror, ["rev-list", "--max-parents=0", "main"]).trim()).toBe(first);
  });

  it("should leave the repo alone when stripLines is empty", async () => {
    const result = await dryRun(ctx, { ...config, stripLines: [] }, "repo", remote);
    expect(result.after).toBeUndefined();
    expect(logs.join("\n")).toMatch(/Nothing to rewrite/);
  });

  it("should remove custom and preset lines together when the list has @ai", async () => {
    await dryRun(ctx, { ...config, stripLines: ["^Internal:", "@ai"] }, "repo", remote);
    const all = messages(repoPaths(ctx.cache, "repo").mirror).join("");
    expect(all).not.toMatch(/Internal:|claude\.ai\/code/);
    expect(all).toContain("fix: plain\n");
  });

  it("should push the cleaned history after a passing dry run", async () => {
    await dryRun(ctx, config, "repo", remote);
    await push(ctx, config, "repo", remote);
    expect(messages(remote).join("")).not.toMatch(/claude\.ai\/code/);
  });
});
