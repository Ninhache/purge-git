import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import type { Config } from "./config";
import { EXIT_REMAINING, PurgeError } from "./errors";
import type { Run } from "./exec";
import {
  filterRepo,
  forcePush,
  localRefs,
  mailmapFile,
  messagesFile,
  mirrorClone,
  type Refs,
  refusalOf,
  remaining,
  remoteRefs,
  type Scan,
  sameRefs,
  scan,
} from "./git";
import { repoPaths } from "./paths";
import { table } from "./table";

export interface Context {
  run: Run;
  cache: string;
  log: (line: string) => void;
}

export interface Marker {
  repo: string;
  url: string;
  preRefs: Refs;
  postRefs: Refs;
  before: Scan;
  after: Scan;
  passed: boolean;
  at: string;
}

export async function freshMirror(ctx: Context, repo: string, url: string): Promise<string> {
  await mkdir(ctx.cache, { recursive: true, mode: 0o700 });
  await chmod(ctx.cache, 0o700);
  const paths = repoPaths(ctx.cache, repo);
  await rm(paths.root, { recursive: true, force: true });
  await mkdir(paths.root, { mode: 0o700 });
  await mirrorClone(ctx.run, url, paths.mirror);
  return paths.mirror;
}

export interface DryRunResult {
  before: Scan;
  after?: Scan;
  left: number;
}

export async function dryRun(
  ctx: Context,
  config: Config,
  repo: string,
  url: string,
): Promise<DryRunResult> {
  const paths = repoPaths(ctx.cache, repo);
  await freshMirror(ctx, repo, url);
  const preRefs = await localRefs(ctx.run, paths.mirror);
  const before = await scan(ctx.run, paths.mirror, config.oldEmails);
  if (before.matching === 0 && before.matchingTags === 0) {
    ctx.log(`${repo}: no commit or tag uses an old address. Nothing to rewrite.`);
    return { before, left: 0 };
  }
  await writeFile(paths.mailmap, mailmapFile(config.identity, config.oldEmails), { mode: 0o600 });
  await writeFile(paths.messages, messagesFile(config.identity.email, config.oldEmails), {
    mode: 0o600,
  });
  await filterRepo(ctx.run, paths.mirror, paths.mailmap, paths.messages);
  const after = await scan(ctx.run, paths.mirror, config.oldEmails);
  const postRefs = await localRefs(ctx.run, paths.mirror);
  const left = remaining(after, config.oldEmails);
  const marker: Marker = {
    repo,
    url,
    preRefs,
    postRefs,
    before,
    after,
    passed: left === 0,
    at: new Date().toISOString(),
  };
  await writeFile(paths.marker, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
  ctx.log(report(repo, config, before, after, left));
  return { before, after, left };
}

export function report(
  repo: string,
  config: Config,
  before: Scan,
  after: Scan,
  left: number,
): string {
  const emails = [
    ...config.oldEmails.map((email) => email.toLowerCase()),
    config.identity.email.toLowerCase(),
  ];
  const count = (result: Scan, email: string) => {
    const entry = result.emails[email];
    return entry ? `${entry.author}/${entry.committer}/${entry.message}` : "0/0/0";
  };
  const rows = emails.map((email) => [email, count(before, email), count(after, email)]);
  const lines = [
    `${repo}: ${before.matching} of ${before.commits} commits and ${before.matchingTags} tags used an old address.`,
    table(["email (author/committer/message)", "before", "after"], rows),
    `Signed commits losing their signature: ${before.signedLost}. Signed tags: ${before.signedTags}.`,
    left === 0
      ? "Proof: no old address left in authors, committers, commit messages, taggers or tag messages."
      : `Proof FAILED: ${left} occurrences of an old address are left.`,
  ];
  return lines.join("\n");
}

export async function readMarker(ctx: Context, repo: string): Promise<Marker> {
  const paths = repoPaths(ctx.cache, repo);
  try {
    return JSON.parse(await readFile(paths.marker, "utf8")) as Marker;
  } catch {
    throw new PurgeError(`${repo}: no verified dry run. Run \`purge-git dry-run ${repo}\` first.`);
  }
}

export async function push(ctx: Context, config: Config, repo: string, url: string): Promise<void> {
  const paths = repoPaths(ctx.cache, repo);
  const marker = await readMarker(ctx, repo);
  if (!marker.passed) {
    throw new PurgeError(
      `${repo}: the dry run left old addresses. Nothing pushed.`,
      EXIT_REMAINING,
    );
  }
  if (marker.url !== url) {
    throw new PurgeError(`${repo}: the dry run was made from ${marker.url}, not ${url}.`);
  }
  if (!sameRefs(await localRefs(ctx.run, paths.mirror), marker.postRefs)) {
    throw new PurgeError(`${repo}: the rewritten clone changed since the dry run. Run it again.`);
  }
  const left = remaining(await scan(ctx.run, paths.mirror, config.oldEmails), config.oldEmails);
  if (left !== 0) {
    throw new PurgeError(
      `${repo}: ${left} old addresses found in the clone. Nothing pushed.`,
      EXIT_REMAINING,
    );
  }
  if (!sameRefs(await remoteRefs(ctx.run, url), marker.preRefs)) {
    throw new PurgeError(
      `${repo}: the remote moved since the dry run (someone pushed). Run the dry run again. Nothing pushed.`,
    );
  }
  const outcome = await forcePush(ctx.run, paths.mirror, url);
  if (!outcome.ok) {
    const reasons = {
      "email-privacy": "GitHub refused it: a commit still exposes a private email (GH007).",
      protected: "A branch protection refused it. Lift it for this push, then run push again.",
      ruleset: "A ruleset refused it. Lift or bypass it for this push, then run push again.",
      other: "The push failed.",
    } as const;
    throw new PurgeError(
      `${repo}: ${reasons[refusalOf(outcome.output)]}\n${outcome.output.trim()}`,
    );
  }
  await rename(paths.marker, `${paths.root}/pushed.json`);
  ctx.log(`${repo}: pushed every branch and tag.`);
}
