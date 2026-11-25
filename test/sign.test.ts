import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../src/config";
import { run } from "../src/exec";
import { type Context, dryRun, push } from "../src/ops";
import { repoPaths } from "../src/paths";
import { commitAs, git, IDENTITY, OLD, sandbox } from "./helpers";

const config: Config = { owner: "me", identity: IDENTITY, oldEmails: OLD };
const previousHome = process.env.GNUPGHOME;
let fingerprint: string;
let root: string;
let remote: string;
let ctx: Context;
let logs: string[];

function statuses(dir: string): string[] {
  return git(dir, ["log", "--format=%s %ce %G?", "main"]).trim().split("\n");
}

beforeAll(() => {
  process.env.GNUPGHOME = mkdtempSync(join(tmpdir(), "pg-gpg-"));
  execFileSync("gpg", [
    "--batch",
    "--passphrase",
    "",
    "--quick-generate-key",
    `${IDENTITY.name} <${IDENTITY.email}>`,
    "ed25519",
    "sign",
    "never",
  ]);
  const listing = execFileSync("gpg", ["--with-colons", "--list-secret-keys"], {
    encoding: "utf8",
  });
  fingerprint = /^fpr:+([0-9A-F]+):/m.exec(listing)?.[1] ?? "";
});

afterAll(() => {
  execFileSync("gpgconf", ["--kill", "gpg-agent"]);
  if (previousHome === undefined) delete process.env.GNUPGHOME;
  else process.env.GNUPGHOME = previousHome;
});

beforeEach(() => {
  root = sandbox();
  appendFileSync(join(root, "gitconfig"), `[user]\n\tsigningkey = ${fingerprint}\n`);
  const work = join(root, "work");
  remote = join(root, "remote.git");
  git(root, ["init", "--quiet", work]);
  commitAs(work, "tester@example.com", "theirs first");
  commitAs(work, OLD[0] ?? "", "mine");
  commitAs(work, "tester@example.com", "theirs after");
  git(work, ["tag", "-a", "v1", "-m", "release"]);
  git(root, ["clone", "--quiet", "--bare", work, remote]);
  logs = [];
  ctx = { run, cache: join(root, "cache"), log: (line) => logs.push(line) };
});

describe("dry run with --sign", () => {
  it("should sign only the commits you commit when signing is asked", async () => {
    const result = await dryRun(ctx, config, "repo", remote, { sign: true });
    expect(result.left).toBe(0);
    expect(statuses(repoPaths(ctx.cache, "repo").mirror)).toEqual([
      "theirs after tester@example.com N",
      `mine ${IDENTITY.email} G`,
      "theirs first tester@example.com N",
    ]);
    expect(logs.join("\n")).toMatch(/Signed 1 of your commits.*Tags moved: 1/);
  });

  it("should keep commits before the first signed one unchanged when signing", async () => {
    const first = git(remote, ["rev-list", "--max-parents=0", "main"]).trim();
    await dryRun(ctx, config, "repo", remote, { sign: true });
    const mirror = repoPaths(ctx.cache, "repo").mirror;
    expect(git(mirror, ["rev-list", "--max-parents=0", "main"]).trim()).toBe(first);
  });

  it("should move an annotated tag onto the re-signed history", async () => {
    await dryRun(ctx, config, "repo", remote, { sign: true });
    const mirror = repoPaths(ctx.cache, "repo").mirror;
    expect(git(mirror, ["rev-parse", "v1^{commit}"])).toBe(git(mirror, ["rev-parse", "main"]));
    expect(git(mirror, ["cat-file", "tag", "v1"])).toMatch(/\n\nrelease\n$/);
  });

  it("should keep author, committer and dates when a commit is re-signed", async () => {
    const before = git(remote, ["log", "--format=%at %ct", "main"]);
    await dryRun(ctx, config, "repo", remote, { sign: true });
    const mirror = repoPaths(ctx.cache, "repo").mirror;
    expect(git(mirror, ["log", "--format=%at %ct", "main"])).toBe(before);
    expect(git(mirror, ["log", "-1", "--format=%an %ae %cn %ce", "main~1"]).trim()).toBe(
      `${IDENTITY.name} ${IDENTITY.email} ${IDENTITY.name} ${IDENTITY.email}`,
    );
  });

  it("should push signed commits after a passing signed dry run", async () => {
    await dryRun(ctx, config, "repo", remote, { sign: true });
    await push(ctx, config, "repo", remote);
    expect(statuses(remote)[1]).toBe(`mine ${IDENTITY.email} G`);
  });

  it("should leave commits unsigned when signing is not asked", async () => {
    await dryRun(ctx, config, "repo", remote);
    expect(statuses(repoPaths(ctx.cache, "repo").mirror)[1]).toBe(`mine ${IDENTITY.email} N`);
  });

  it("should stop with an unlock hint when the signing key cannot sign", async () => {
    appendFileSync(join(root, "gitconfig"), "[user]\n\tsigningkey = 0000000000000000\n");
    await expect(dryRun(ctx, config, "repo", remote, { sign: true })).rejects.toThrow(
      /Signing failed[\s\S]*Unlock your key/,
    );
  });
});
