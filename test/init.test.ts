import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { configState, loadConfig, TEMPLATE, writeConfig, writeTemplate } from "../src/config";
import { type Candidate, candidates, preselected, type Tallies, tally } from "../src/discover";
import { type Run, run } from "../src/exec";
import { discoverConfig } from "../src/init";
import type { Context } from "../src/ops";
import { commitAs, git, sandbox } from "./helpers";

const USER = { login: "me", id: 1, name: "Me" };
const NOREPLY = "1+me@users.noreply.github.com";

function searchItem(sha: string, email: string, name = "Me") {
  return { sha, commit: { author: { name, email } }, repository: { full_name: "me/app" } };
}

function fakeGh(remote: string, options: { userScope: boolean; items: unknown[] }) {
  const calls: string[][] = [];
  const runner: Run = async (command, args, opts) => {
    if (command !== "gh") return run(command, args, opts);
    calls.push(args);
    const ok = (body: unknown) => ({ code: 0, stdout: JSON.stringify(body), stderr: "" });
    if (args[1] === "user") return ok(USER);
    if (args[1] === "user/emails") {
      return options.userScope
        ? ok([{ email: "account@example.com" }, { email: NOREPLY }])
        : { code: 1, stdout: "", stderr: 'needs the "user" scope' };
    }
    if (args.includes("search/commits")) {
      return ok({ total_count: options.items.length, items: options.items });
    }
    if (args[0] === "repo" && args[1] === "list") {
      return ok([
        {
          name: "app",
          visibility: "PUBLIC",
          defaultBranchRef: { name: "main" },
          isFork: false,
          isArchived: false,
        },
      ]);
    }
    return { code: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")} for ${remote}` };
  };
  return { runner, calls };
}

let root: string;
let remote: string;
let ctx: Context;
let logs: string[];

beforeEach(() => {
  root = sandbox();
  const work = join(root, "work");
  remote = join(root, "remote.git");
  git(root, ["init", "--quiet", work]);
  commitAs(work, "linked@example.com", "linked");
  commitAs(work, "unlinked@example.com", "gone from the account");
  git(work, ["commit", "--quiet", "--allow-empty", "-m", "by me"], {
    GIT_AUTHOR_NAME: "Me",
    GIT_AUTHOR_EMAIL: "forgotten@example.com",
  });
  git(work, ["commit", "--quiet", "--allow-empty", "-m", "a contributor"], {
    GIT_AUTHOR_NAME: "Contributor",
    GIT_AUTHOR_EMAIL: "contributor@example.com",
  });
  git(root, ["clone", "--quiet", "--bare", work, remote]);
  logs = [];
});

function context(runner: Run): Context {
  return { run: runner, cache: join(root, "cache"), log: (line) => logs.push(line) };
}

describe("discoverConfig", () => {
  it("should offer linked and same-name addresses when the local scan runs", async () => {
    const { runner } = fakeGh(remote, {
      userScope: true,
      items: [searchItem("a", "Linked@Example.com", "Someone"), searchItem("b", NOREPLY)],
    });
    ctx = context(runner);
    let offered: Candidate[] = [];
    const config = await discoverConfig({
      ctx,
      sleep: async () => undefined,
      confirmLocal: async () => true,
      pickEmails: async (found) => {
        offered = found;
        return found.filter(preselected).map((candidate) => candidate.email);
      },
      remote: () => remote,
    });
    expect(config.owner).toBe("me");
    expect(config.identity).toEqual({ name: "Me", email: NOREPLY });
    const emails = offered.map((candidate) => candidate.email);
    expect(emails).toContain("linked@example.com");
    expect(emails).toContain("account@example.com");
    expect(emails).toContain("forgotten@example.com");
    expect(emails).toContain("unlinked@example.com");
    expect(emails.at(-1)).toBe("contributor@example.com");
    expect(offered.find((candidate) => candidate.email === "contributor@example.com")?.mine).toBe(
      false,
    );
    expect(emails).not.toContain(NOREPLY);
    expect(config.oldEmails.sort()).toEqual(["account@example.com", "linked@example.com"]);
  });

  it("should fall back to commit search when the user scope is missing", async () => {
    const { runner, calls } = fakeGh(remote, {
      userScope: false,
      items: [searchItem("a", "linked@example.com")],
    });
    ctx = context(runner);
    const config = await discoverConfig({
      ctx,
      sleep: async () => undefined,
      confirmLocal: async () => false,
      pickEmails: async (found) => found.map((candidate) => candidate.email),
    });
    expect(config.oldEmails).toEqual(["linked@example.com"]);
    expect(logs.join("\n")).toMatch(/gh auth refresh -h github\.com -s user:email/);
    expect(calls.filter((args) => args.includes("search/commits"))).toHaveLength(1);
  });

  it("should refuse to build a config when nothing is picked", async () => {
    const { runner } = fakeGh(remote, {
      userScope: false,
      items: [searchItem("a", "x@example.com")],
    });
    ctx = context(runner);
    const base = { ctx, sleep: async () => undefined, confirmLocal: async () => false };
    await expect(discoverConfig({ ...base, pickEmails: async () => [] })).rejects.toThrow(
      /No address picked/,
    );
    await expect(discoverConfig({ ...base, pickEmails: async () => null })).rejects.toThrow(
      /Cancelled/,
    );
  });
});

describe("candidates", () => {
  it("should list other names last and drop noreply addresses when listing candidates", () => {
    const tallies: Tallies = new Map();
    tally(tallies, "mine@example.com", "Me", "search");
    tally(tallies, "alias@example.com", "Me", "local");
    tally(tallies, "them@example.com", "Them", "local");
    tally(tallies, "2+me@users.noreply.github.com", "Me", "search");
    const found = candidates(tallies, USER, NOREPLY).map((candidate) => candidate.email);
    expect(found).toEqual(["mine@example.com", "alias@example.com", "them@example.com"]);
  });
});

describe("writeConfig", () => {
  it("should write mode 0600 and replace an untouched template when saving", async () => {
    const path = join(root, "config", "config.json");
    expect(await configState(path)).toBe("none");
    expect(await writeTemplate(path)).toBe(true);
    expect(await configState(path)).toBe("template");
    await writeConfig(path, { ...TEMPLATE, owner: "me" });
    expect(await configState(path)).toBe("custom");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect((await loadConfig(path)).owner).toBe("me");
    expect(JSON.parse(await readFile(path, "utf8")).owner).toBe("me");
  });
});
