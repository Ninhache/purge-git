import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Config, oldLabel } from "./config";
import { EXIT_REMAINING, PurgeError } from "./errors";
import type { Run } from "./exec";
import {
  bundle,
  filterRepo,
  forcePush,
  localRefs,
  mailmapFile,
  messagesFile,
  mirrorClone,
  pushPlan,
  type RefChange,
  type Refs,
  refsBetween,
  refusalOf,
  remaining,
  remoteRefs,
  type Scan,
  sameRefs,
  scan,
} from "./git";
import { inventoryFile, type RepoPaths, repoPaths } from "./paths";
import { type SignResult, signMine, unsignedMine } from "./sign";
import { lineMatchers, stripPatterns } from "./strip";
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
  backup: string;
  before: Scan;
  after: Scan;
  signed?: SignResult;
  passed: boolean;
  at: string;
}

export async function freshClone(
  ctx: Context,
  repo: string,
  url: string,
  kind: "mirror" | "inventory",
): Promise<string> {
  await mkdir(ctx.cache, { recursive: true, mode: 0o700 });
  await chmod(ctx.cache, 0o700);
  const paths = repoPaths(ctx.cache, repo);
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  await chmod(paths.root, 0o700);
  const target = paths[kind];
  await rm(target, { recursive: true, force: true });
  if (kind === "mirror") await rm(paths.marker, { force: true });
  await mirrorClone(ctx.run, url, target);
  return target;
}

export interface InventoryRow {
  name: string;
  commits: number;
  tags: number;
  defaultBranch: string;
  protected: string;
  visibility: string;
  openPullRequests: number;
  releases: number;
  signedLost: number;
}

export async function saveInventory(ctx: Context, rows: InventoryRow[]): Promise<void> {
  await mkdir(ctx.cache, { recursive: true, mode: 0o700 });
  await writeFile(inventoryFile(ctx.cache), `${JSON.stringify(rows, null, 2)}\n`, { mode: 0o600 });
}

export async function readInventory(ctx: Context): Promise<InventoryRow[]> {
  try {
    return JSON.parse(await readFile(inventoryFile(ctx.cache), "utf8")) as InventoryRow[];
  } catch {
    throw new PurgeError("No inventory yet. Run `purge-git inventory` first, or name a repo.");
  }
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
  options: { sign?: boolean } = {},
): Promise<DryRunResult> {
  const paths = repoPaths(ctx.cache, repo);
  await freshClone(ctx, repo, url, "mirror");
  const preRefs = await localRefs(ctx.run, paths.mirror);
  const patterns = stripPatterns(config);
  const matchers = lineMatchers(patterns);
  const before = await scan(ctx.run, paths.mirror, config.oldEmails, matchers);
  if (before.matching === 0 && before.matchingTags === 0) {
    ctx.log(`${repo}: no commit or tag uses an old address or an AI line. Nothing to rewrite.`);
    return { before, left: 0 };
  }
  const at = new Date().toISOString();
  const backup = await backupOf(ctx, paths, at);
  await writeFile(paths.mailmap, mailmapFile(config.identity, config.oldEmails), { mode: 0o600 });
  await writeFile(paths.messages, messagesFile(config.identity.email, config.oldEmails), {
    mode: 0o600,
  });
  await filterRepo(ctx.run, paths.mirror, paths.mailmap, paths.messages, patterns);
  const signed = options.sign
    ? await signMine(ctx.run, paths.mirror, config.identity.email)
    : undefined;
  const after = await scan(ctx.run, paths.mirror, config.oldEmails, matchers);
  const postRefs = await localRefs(ctx.run, paths.mirror);
  const unsigned = signed ? await unsignedMine(ctx.run, paths.mirror, config.identity.email) : 0;
  const left = remaining(after, config.oldEmails) + unsigned;
  const marker: Marker = {
    repo,
    url,
    preRefs,
    postRefs,
    backup,
    before,
    after,
    signed,
    passed: left === 0,
    at,
  };
  await writeFile(paths.marker, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
  ctx.log(report(repo, config, before, after, left));
  if (signed) ctx.log(signReport(signed, unsigned));
  return { before, after, left };
}

async function backupOf(ctx: Context, paths: RepoPaths, at: string): Promise<string> {
  await mkdir(paths.backups, { recursive: true, mode: 0o700 });
  await chmod(paths.backups, 0o700);
  const file = join(paths.backups, `${at.replace(/[:.]/g, "-")}.bundle`);
  await bundle(ctx.run, paths.mirror, file);
  await chmod(file, 0o600);
  ctx.log(`Original history saved to ${file}`);
  return file;
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
  const rows = emails.map((email) => [
    oldLabel(config.oldEmails, email),
    count(before, email),
    count(after, email),
  ]);
  const lines = [
    `${repo}: ${before.matching} of ${before.commits} commits and ${before.matchingTags} tags used an old address or an AI line.`,
    table(["email (author/committer/message)", "before", "after"], rows),
    `AI lines in messages: ${before.lines} before, ${after.lines} after.`,
    `Signed commits losing their signature: ${before.signedLost}. Signed tags: ${before.signedTags}.`,
    left === 0
      ? "Proof: no old address left in authors, committers, commit messages, taggers or tag messages, and no AI line left."
      : `Proof FAILED: ${left} occurrences of an old address or an AI line are left.`,
  ];
  return lines.join("\n");
}

export function signReport(signed: SignResult, unsigned: number): string {
  const lines = [
    `Signed ${signed.signed} of your commits; ${signed.recreated - signed.signed} other commits were re-parented and ${signed.othersLost} of them lose a signature. Tags moved: ${signed.tagsMoved}.`,
    unsigned === 0
      ? "Proof: every commit you committed carries a good signature."
      : `Proof FAILED: ${unsigned} of your commits have no good signature.`,
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

export async function push(
  ctx: Context,
  config: Config,
  repo: string,
  url: string,
  options: { dryRun?: boolean } = {},
): Promise<void> {
  const paths = repoPaths(ctx.cache, repo);
  const marker = await readMarker(ctx, repo);
  if (!marker.passed) {
    throw new PurgeError(
      `${repo}: the dry run left old addresses. Nothing pushed.`,
      EXIT_REMAINING,
    );
  }
  if (!marker.backup || !existsSync(marker.backup)) {
    throw new PurgeError(
      `${repo}: the backup of the original history is missing. Run the dry run again. Nothing pushed.`,
    );
  }
  if (marker.url !== url) {
    throw new PurgeError(`${repo}: the dry run was made from ${marker.url}, not ${url}.`);
  }
  const local = await localRefs(ctx.run, paths.mirror);
  if (!sameRefs(local, marker.postRefs)) {
    throw new PurgeError(`${repo}: the rewritten clone changed since the dry run. Run it again.`);
  }
  const check = await scan(
    ctx.run,
    paths.mirror,
    config.oldEmails,
    lineMatchers(stripPatterns(config)),
  );
  const left = remaining(check, config.oldEmails);
  if (left !== 0) {
    throw new PurgeError(
      `${repo}: ${left} old addresses or AI lines found in the clone. Nothing pushed.`,
      EXIT_REMAINING,
    );
  }
  if (marker.signed && (await unsignedMine(ctx.run, paths.mirror, config.identity.email)) > 0) {
    throw new PurgeError(
      `${repo}: some of your commits lost their signature since the dry run. Run it again. Nothing pushed.`,
      EXIT_REMAINING,
    );
  }
  const current = await remoteRefs(ctx.run, url);
  if (!refsBetween(current, marker.preRefs, marker.postRefs)) {
    throw new PurgeError(
      `${repo}: the remote moved since the dry run (someone pushed). Run the dry run again. Nothing pushed.`,
    );
  }
  if (options.dryRun) {
    logPlan(ctx, repo, pushPlan(current, local));
    return;
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
      `${repo}: ${reasons[refusalOf(outcome.output)]} Refs that were not refused may already be pushed: running push again is safe.\n${outcome.output.trim()}`,
    );
  }
  await rename(paths.marker, `${paths.root}/pushed.json`);
  ctx.log(`${repo}: pushed every branch and tag.`);
}

function logPlan(ctx: Context, repo: string, plan: RefChange[]): void {
  const short = (sha: string) => sha.slice(0, 7);
  const width = Math.max(...plan.map((change) => change.ref.length));
  ctx.log(`${repo}: dry run of the push. Nothing is sent to GitHub.`);
  for (const change of plan) {
    const what =
      change.from === change.to
        ? "already pushed"
        : change.from === undefined
          ? `created at ${short(change.to)}`
          : `${short(change.from)} -> ${short(change.to)} (force)`;
    ctx.log(`  ${change.ref.padEnd(width)}  ${what}`);
  }
  const replaced = plan.filter((change) => change.from && change.from !== change.to).length;
  const created = plan.filter((change) => change.from === undefined).length;
  ctx.log(
    `${replaced} refs would be replaced and ${created} created. The backup keeps the old ones.`,
  );
}
