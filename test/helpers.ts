import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), "purge-git-test-"));
  const gitconfig = join(dir, "gitconfig");
  writeFileSync(
    gitconfig,
    "[user]\n\tname = Tester\n\temail = tester@example.com\n[commit]\n\tgpgsign = false\n[tag]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n",
  );
  process.env.GIT_CONFIG_GLOBAL = gitconfig;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  return dir;
}

export function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync("git", args, { cwd, env: { ...process.env, ...env }, encoding: "utf8" });
}

export function commitAs(cwd: string, email: string, message: string, committer = email): void {
  git(cwd, ["commit", "--quiet", "--allow-empty", "-m", message], {
    GIT_AUTHOR_NAME: "Someone",
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: "Someone",
    GIT_COMMITTER_EMAIL: committer,
  });
}

export const OLD = ["old@example.com", "older@example.com"];
export const IDENTITY = { name: "Me", email: "1+me@users.noreply.github.com" };

export function fixture(root: string): { work: string; remote: string } {
  const work = join(root, "work");
  const remote = join(root, "remote.git");
  git(root, ["init", "--quiet", work]);
  commitAs(work, "OLD@Example.com", "first");
  commitAs(work, "tester@example.com", "second\n\nSigned-off-by: Old <old@example.com>");
  commitAs(work, "tester@example.com", "third", "older@example.com");
  git(work, ["tag", "-a", "v1", "-m", "release by old@example.com"], {
    GIT_COMMITTER_EMAIL: "old@example.com",
  });
  git(work, ["switch", "--quiet", "-c", "feature"]);
  commitAs(work, "old@example.com", "on a branch");
  git(work, ["switch", "--quiet", "main"]);
  git(root, ["clone", "--quiet", "--bare", work, remote]);
  return { work, remote };
}
