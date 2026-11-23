import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../src/config";
import { run } from "../src/exec";
import { remaining, scan } from "../src/git";
import { type Context, dryRun, push } from "../src/ops";
import { repoPaths } from "../src/paths";
import { commitAs, fixture, git, IDENTITY, OLD, sandbox } from "./helpers";

const config: Config = { owner: "me", identity: IDENTITY, oldEmails: OLD, orgs: ["acme"] };

let root: string;
let remote: string;
let work: string;
let ctx: Context;
let logs: string[];

beforeEach(() => {
  root = sandbox();
  ({ work, remote } = fixture(root));
  logs = [];
  ctx = { run, cache: join(root, "cache"), log: (line) => logs.push(line) };
});

describe("dry run", () => {
  it("rewrites authors, committers, messages and tags without touching the remote", async () => {
    const remoteBefore = git(remote, ["for-each-ref"]);
    const result = await dryRun(ctx, config, "repo", remote);
    expect(result.before.matching).toBe(4);
    expect(result.before.matchingTags).toBe(1);
    expect(result.left).toBe(0);
    const mirror = repoPaths(ctx.cache, "repo").mirror;
    const emails = git(mirror, ["log", "--all", "--format=%ae %ce %B"]).toLowerCase();
    for (const old of OLD) expect(emails).not.toContain(old);
    expect(emails).toContain(IDENTITY.email);
    expect(emails).toContain("tester@example.com");
    const tag = git(mirror, ["for-each-ref", "refs/tags", "--format=%(taggeremail) %(contents)"]);
    expect(tag).not.toMatch(/old@example\.com/i);
    expect(git(remote, ["for-each-ref"])).toBe(remoteBefore);
    expect(logs.join("\n")).toMatch(/Proof: no old address left/);
  });

  it("keeps the cache private", async () => {
    await dryRun(ctx, config, "repo", remote);
    const paths = repoPaths(ctx.cache, "repo");
    expect(statSync(ctx.cache).mode & 0o777).toBe(0o700);
    expect(statSync(paths.root).mode & 0o777).toBe(0o700);
    expect(statSync(paths.mailmap).mode & 0o777).toBe(0o600);
    expect(statSync(paths.marker).mode & 0o777).toBe(0o600);
  });

  it("should save the original history privately when it rewrites", async () => {
    const original = git(remote, ["for-each-ref", "refs/heads", "refs/tags"]);
    await dryRun(ctx, config, "repo", remote);
    const { backups } = repoPaths(ctx.cache, "repo");
    const [file] = readdirSync(backups);
    expect(statSync(backups).mode & 0o777).toBe(0o700);
    expect(statSync(join(backups, `${file}`)).mode & 0o777).toBe(0o600);
    const restored = join(root, "restored.git");
    git(root, ["clone", "--quiet", "--mirror", join(backups, `${file}`), restored]);
    expect(git(restored, ["for-each-ref", "refs/heads", "refs/tags"])).toBe(original);
  });

  it("should keep earlier backups when the dry run runs again", async () => {
    await dryRun(ctx, config, "repo", remote);
    await dryRun(ctx, config, "repo", remote);
    expect(readdirSync(repoPaths(ctx.cache, "repo").backups)).toHaveLength(2);
  });

  it("should keep an org repo apart from your own repos when caching", async () => {
    await dryRun(ctx, config, "acme/repo", remote);
    const paths = repoPaths(ctx.cache, "acme/repo");
    expect(paths.root).toBe(join(ctx.cache, "@acme", "repo"));
    expect(existsSync(paths.marker)).toBe(true);
    expect(existsSync(repoPaths(ctx.cache, "repo").root)).toBe(false);
  });

  it("leaves a clean repo alone", async () => {
    const clean = { ...config, oldEmails: ["nobody@example.com"] };
    const result = await dryRun(ctx, clean, "repo", remote);
    expect(result.before.matching).toBe(0);
    expect(existsSync(repoPaths(ctx.cache, "repo").marker)).toBe(false);
  });
});

describe("push", () => {
  it("refuses without a dry run", async () => {
    await expect(push(ctx, config, "repo", remote)).rejects.toThrow(/no verified dry run/);
  });

  it("pushes every branch and tag of a verified rewrite", async () => {
    await dryRun(ctx, config, "repo", remote);
    await push(ctx, config, "repo", remote);
    const result = await scan(run, remote, OLD);
    expect(remaining(result, OLD)).toBe(0);
    expect(
      git(remote, ["branch", "--format=%(refname:short)"]).split("\n").filter(Boolean).sort(),
    ).toEqual(["feature", "main"]);
    expect(git(remote, ["tag"]).trim()).toBe("v1");
    await expect(push(ctx, config, "repo", remote)).rejects.toThrow(/no verified dry run/);
  });

  it("leaves refs/pull alone and does not count them", async () => {
    const pull = git(remote, ["rev-parse", "refs/pull/1/head"]);
    const result = await dryRun(ctx, config, "repo", remote);
    expect(result.before.matching).toBe(4);
    await push(ctx, config, "repo", remote);
    expect(git(remote, ["rev-parse", "refs/pull/1/head"])).toBe(pull);
  });

  it("finishes a push that was partly done", async () => {
    await dryRun(ctx, config, "repo", remote);
    const mirror = repoPaths(ctx.cache, "repo").mirror;
    git(mirror, ["push", "--quiet", "--force", remote, "refs/heads/feature:refs/heads/feature"]);
    await push(ctx, config, "repo", remote);
    expect(remaining(await scan(run, remote, OLD), OLD)).toBe(0);
  });

  it("refuses when the remote moved since the dry run", async () => {
    await dryRun(ctx, config, "repo", remote);
    commitAs(work, "tester@example.com", "late commit");
    git(work, ["push", "--quiet", remote, "main"]);
    const remoteBefore = git(remote, ["for-each-ref"]);
    await expect(push(ctx, config, "repo", remote)).rejects.toThrow(/remote moved/);
    expect(git(remote, ["for-each-ref"])).toBe(remoteBefore);
  });

  it("should refuse to push when the backup is missing", async () => {
    await dryRun(ctx, config, "repo", remote);
    rmSync(repoPaths(ctx.cache, "repo").backups, { recursive: true });
    const remoteBefore = git(remote, ["for-each-ref"]);
    await expect(push(ctx, config, "repo", remote)).rejects.toThrow(/backup/);
    expect(git(remote, ["for-each-ref"])).toBe(remoteBefore);
  });

  it("refuses another remote than the one of the dry run", async () => {
    await dryRun(ctx, config, "repo", remote);
    await expect(push(ctx, config, "repo", join(root, "other.git"))).rejects.toThrow(
      /was made from/,
    );
  });

  it("refuses when the rewritten clone changed", async () => {
    await dryRun(ctx, config, "repo", remote);
    const mirror = repoPaths(ctx.cache, "repo").mirror;
    git(mirror, ["update-ref", "refs/heads/extra", "refs/heads/main"]);
    await expect(push(ctx, config, "repo", remote)).rejects.toThrow(/changed since the dry run/);
  });
});
