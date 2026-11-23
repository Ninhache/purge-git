import { type Run, runOk } from "./exec";

export type Refs = Record<string, string>;

const PUSHED_REFS = /^refs\/(heads|tags)\//;

export async function filterRepoVersion(runner: Run): Promise<string | undefined> {
  const result = await runner("git", ["filter-repo", "--version"]);
  return result.code === 0 ? result.stdout.trim() : undefined;
}

export async function mirrorClone(runner: Run, url: string, dir: string): Promise<void> {
  await runOk(runner, "git", ["clone", "--quiet", "--mirror", url, dir]);
}

export async function bundle(runner: Run, dir: string, file: string): Promise<void> {
  await runOk(runner, "git", ["-C", dir, "bundle", "create", "--quiet", file, "--all"]);
}

export async function localRefs(runner: Run, dir: string): Promise<Refs> {
  const out = await runOk(runner, "git", [
    "-C",
    dir,
    "for-each-ref",
    "--format=%(objectname) %(refname)",
    "refs/heads",
    "refs/tags",
  ]);
  return parseRefs(out);
}

export async function remoteRefs(runner: Run, url: string): Promise<Refs> {
  const out = await runOk(runner, "git", ["ls-remote", "--heads", "--tags", url]);
  return parseRefs(out.replaceAll("\t", " "));
}

export function parseRefs(out: string): Refs {
  const refs: Refs = {};
  for (const line of out.split("\n")) {
    const [sha, ref] = line.trim().split(" ");
    if (!sha || !ref || ref.endsWith("^{}") || !PUSHED_REFS.test(ref)) continue;
    refs[ref] = sha;
  }
  return refs;
}

export function refsBetween(current: Refs, before: Refs, after: Refs): boolean {
  const keys = Object.keys(current);
  return (
    keys.length === Object.keys(before).length &&
    keys.every((key) => current[key] === before[key] || current[key] === after[key])
  );
}

export function sameRefs(a: Refs, b: Refs): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

export async function hasCommits(runner: Run, dir: string): Promise<boolean> {
  const result = await runner("git", [
    "-C",
    dir,
    "rev-list",
    "--branches",
    "--tags",
    "--max-count=1",
  ]);
  return result.code === 0 && result.stdout.trim() !== "";
}

export interface EmailCount {
  author: number;
  committer: number;
  message: number;
}

export interface Scan {
  commits: number;
  matching: number;
  signedLost: number;
  emails: Record<string, EmailCount>;
  tags: number;
  matchingTags: number;
  signedTags: number;
}

const FIELD = "\u0000";
const RECORD = "\u001e";

export async function scan(runner: Run, dir: string, oldEmails: string[]): Promise<Scan> {
  const olds = oldEmails.map((email) => email.toLowerCase());
  const emails: Record<string, EmailCount> = {};
  const bump = (email: string, key: keyof EmailCount) => {
    emails[email] ??= { author: 0, committer: 0, message: 0 };
    emails[email][key] += 1;
  };
  const result: Scan = {
    commits: 0,
    matching: 0,
    signedLost: 0,
    emails,
    tags: 0,
    matchingTags: 0,
    signedTags: 0,
  };
  for (const email of olds) emails[email] = { author: 0, committer: 0, message: 0 };

  if (await hasCommits(runner, dir)) {
    const log = await runOk(runner, "git", [
      "-C",
      dir,
      "log",
      "--branches",
      "--tags",
      "--topo-order",
      "--reverse",
      "--format=%H%x00%P%x00%ae%x00%ce%x00%G?%x00%B%x1e",
    ]);
    const rewritten = new Set<string>();
    for (const record of log.split(RECORD)) {
      const fields = record.replace(/^\n/, "").split(FIELD);
      const [sha, parents = "", author = "", committer = "", signature = "N", body = ""] = fields;
      if (!sha) continue;
      result.commits += 1;
      const ae = author.toLowerCase();
      const ce = committer.toLowerCase();
      const message = body.toLowerCase();
      bump(ae, "author");
      bump(ce, "committer");
      let matches = false;
      for (const old of olds) {
        if (message.includes(old)) {
          bump(old, "message");
          matches = true;
        }
      }
      if (olds.includes(ae) || olds.includes(ce)) matches = true;
      if (matches) result.matching += 1;
      const inherits = parents.split(" ").some((parent) => rewritten.has(parent));
      if (matches || inherits) {
        rewritten.add(sha);
        if (signature !== "N") result.signedLost += 1;
      }
    }
  }

  const tags = await runOk(runner, "git", [
    "-C",
    dir,
    "for-each-ref",
    "refs/tags",
    "--format=%(objecttype)%00%(taggeremail)%00%(contents:signature)%00%(contents)%1e",
  ]);
  for (const record of tags.split(RECORD)) {
    const [type, tagger = "", signature = "", contents = ""] = record
      .replace(/^\n/, "")
      .split(FIELD);
    if (!type) continue;
    result.tags += 1;
    if (type !== "tag") continue;
    const text = `${tagger} ${contents}`.toLowerCase();
    const matches = olds.some((old) => text.includes(old));
    if (matches) result.matchingTags += 1;
    if (signature.trim() !== "") result.signedTags += 1;
  }
  return result;
}

export function remaining(result: Scan, oldEmails: string[]): number {
  return (
    oldEmails.reduce((sum, email) => {
      const count = result.emails[email.toLowerCase()];
      return sum + (count ? count.author + count.committer + count.message : 0);
    }, 0) + result.matchingTags
  );
}

export function mailmapFile(
  identity: { name: string; email: string },
  oldEmails: string[],
): string {
  return oldEmails.map((old) => `${identity.name} <${identity.email}> <${old}>\n`).join("");
}

export function messagesFile(identityEmail: string, oldEmails: string[]): string {
  return oldEmails
    .map((old) => `regex:(?i)${old.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}==>${identityEmail}\n`)
    .join("");
}

export async function filterRepo(
  runner: Run,
  dir: string,
  mailmap: string,
  messages: string,
): Promise<void> {
  await runOk(runner, "git", [
    "-C",
    dir,
    "filter-repo",
    "--quiet",
    "--mailmap",
    mailmap,
    "--replace-message",
    messages,
  ]);
}

export interface PushOutcome {
  ok: boolean;
  output: string;
}

export async function forcePush(runner: Run, dir: string, url: string): Promise<PushOutcome> {
  const existing = await runner("git", ["-C", dir, "remote", "get-url", "origin"]);
  if (existing.code === 0) {
    await runOk(runner, "git", ["-C", dir, "remote", "set-url", "origin", url]);
  } else {
    await runOk(runner, "git", ["-C", dir, "remote", "add", "origin", url]);
  }
  const branches = await runner("git", ["-C", dir, "push", "--force", "--all", "origin"]);
  if (branches.code !== 0) return { ok: false, output: branches.stderr };
  const tags = await runner("git", ["-C", dir, "push", "--force", "--tags", "origin"]);
  return { ok: tags.code === 0, output: `${branches.stderr}${tags.stderr}` };
}

export type Refusal = "email-privacy" | "protected" | "ruleset" | "other";

export function refusalOf(output: string): Refusal {
  if (output.includes("GH007")) return "email-privacy";
  if (output.includes("GH013")) return "ruleset";
  if (output.includes("GH006") || /protected branch/i.test(output)) return "protected";
  return "other";
}
