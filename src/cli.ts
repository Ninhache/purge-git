#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { defineCommand, runMain } from "citty";
import { type Config, isRepoName, loadConfig, writeTemplate } from "./config";
import { EXIT_ERROR, EXIT_REMAINING, PurgeError } from "./errors";
import { run } from "./exec";
import { filterRepoVersion, scan } from "./git";
import {
  openPullRequests,
  ownedRepos,
  protections,
  releases,
  type SearchField,
  searchCommits,
} from "./github";
import { type Context, dryRun, freshMirror, push } from "./ops";
import { cacheRoot, configPath, sshRemote } from "./paths";
import { table } from "./table";
import { CLI_VERSION } from "./version";

const FIELDS: SearchField[] = ["author-email", "committer-email"];

function guarded<T>(action: (input: T) => Promise<void>): (input: T) => Promise<void> {
  return async (input) => {
    try {
      await action(input);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = error instanceof PurgeError ? error.exitCode : EXIT_ERROR;
    }
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function context(): Context {
  return { run, cache: cacheRoot(), log: (line) => console.log(line) };
}

async function setup(): Promise<{ ctx: Context; config: Config }> {
  const config = await loadConfig(configPath());
  if (!(await filterRepoVersion(run))) {
    throw new PurgeError(
      "git filter-repo is missing. Install it: `pacman -S git-filter-repo`, `brew install git-filter-repo` or `pipx install git-filter-repo`.",
    );
  }
  return { ctx: context(), config };
}

async function ownedRepo(config: Config, repo: string) {
  if (!isRepoName(repo)) throw new PurgeError(`Not a repository name: ${repo}`);
  const found = (await ownedRepos(run, config.owner)).find((item) => item.name === repo);
  if (!found) {
    throw new PurgeError(
      `${config.owner}/${repo} is not one of your own repos (not a fork, not archived).`,
    );
  }
  return found;
}

async function searchAll(config: Config) {
  const byRepo: Record<string, number> = {};
  const totals: string[][] = [];
  for (const email of config.oldEmails) {
    for (const field of FIELDS) {
      const hits = await searchCommits(run, field, email, sleep);
      totals.push([email, field, String(hits.total)]);
      for (const [name, count] of Object.entries(hits.byRepo)) {
        byRepo[name] = (byRepo[name] ?? 0) + count;
      }
    }
  }
  return { byRepo, totals };
}

function othersOf(config: Config, byRepo: Record<string, number>): string[] {
  const prefix = `${config.owner.toLowerCase()}/`;
  return Object.keys(byRepo)
    .filter((name) => !name.toLowerCase().startsWith(prefix))
    .sort();
}

const init = defineCommand({
  meta: { name: "init", description: "Write a config template (mode 0600)" },
  run: guarded(async () => {
    const path = configPath();
    const created = await writeTemplate(path);
    console.log(
      created ? `Wrote ${path}. Fill in owner, identity and oldEmails.` : `${path} already exists.`,
    );
  }),
});

const inventory = defineCommand({
  meta: { name: "inventory", description: "Read-only: count old addresses in each of your repos" },
  args: {
    repo: { type: "string", description: "Only this repo" },
  },
  run: guarded(async ({ args }) => {
    const { ctx, config } = await setup();
    const repos = (await ownedRepos(run, config.owner)).filter(
      (item) => !args.repo || item.name === args.repo,
    );
    const { byRepo, totals } = await searchAll(config);
    console.log(table(["email", "search", "commits found"], totals));
    console.log("");
    const rows: (string | number)[][] = [];
    let clean = 0;
    for (const item of repos) {
      ctx.log(`Scanning ${item.name}...`);
      const mirror = await freshMirror(ctx, item.name, sshRemote(config.owner, item.name));
      const result = await scan(run, mirror, config.oldEmails);
      if (result.matching === 0 && result.matchingTags === 0) {
        clean += 1;
        continue;
      }
      const guard = await protections(run, config.owner, item.name);
      rows.push([
        item.name,
        result.matching,
        result.matchingTags,
        item.defaultBranch,
        [...guard.branches, ...guard.rulesets.map((name) => `ruleset:${name}`)].join(",") ||
          (guard.unknown ? "?" : "-"),
        item.visibility,
        await openPullRequests(run, config.owner, item.name),
        await releases(run, config.owner, item.name),
        result.signedLost,
      ]);
    }
    console.log("");
    console.log(
      table(
        [
          "repo",
          "commits",
          "tags",
          "default",
          "protected",
          "visibility",
          "open PRs",
          "releases",
          "signed lost",
        ],
        rows,
      ),
    );
    console.log(`\n${rows.length} repos to rewrite, ${clean} clean.`);
    const others = othersOf(config, byRepo);
    if (others.length > 0) {
      console.log("\nRepos you don't own with an old address (ask their owners):");
      for (const name of others) console.log(`  ${name} (${byRepo[name]} commits)`);
    }
  }),
});

const dryRunCommand = defineCommand({
  meta: { name: "dry-run", description: "Rewrite a fresh clone and prove no old address is left" },
  args: { repo: { type: "positional", required: true, description: "Repository name" } },
  run: guarded(async ({ args }) => {
    const { ctx, config } = await setup();
    await ownedRepo(config, args.repo);
    const result = await dryRun(ctx, config, args.repo, sshRemote(config.owner, args.repo));
    if (result.left > 0) process.exitCode = EXIT_REMAINING;
  }),
});

async function confirmName(repo: string, given: string | undefined): Promise<void> {
  if (given !== undefined) {
    if (given !== repo)
      throw new PurgeError(`--confirm ${given} does not match ${repo}. Nothing pushed.`);
    return;
  }
  if (!process.stdin.isTTY) throw new PurgeError(`Pass --confirm ${repo} to push.`);
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await prompt.question(`Type ${repo} to force-push its rewritten history: `);
  prompt.close();
  if (answer.trim() !== repo) throw new PurgeError("Name did not match. Nothing pushed.");
}

const pushCommand = defineCommand({
  meta: { name: "push", description: "Force-push a verified rewrite (branches, then tags)" },
  args: {
    repo: { type: "positional", required: true, description: "Repository name" },
    confirm: { type: "string", description: "Repeat the repository name" },
  },
  run: guarded(async ({ args }) => {
    const { ctx, config } = await setup();
    await ownedRepo(config, args.repo);
    const guard = await protections(run, config.owner, args.repo);
    const prs = await openPullRequests(run, config.owner, args.repo);
    const tagged = await releases(run, config.owner, args.repo);
    if (guard.branches.length > 0) console.log(`Protected branches: ${guard.branches.join(", ")}`);
    if (guard.rulesets.length > 0) console.log(`Active rulesets: ${guard.rulesets.join(", ")}`);
    if (prs > 0)
      console.log(`Warning: ${prs} open PRs will no longer match the rewritten history.`);
    if (tagged > 0) console.log(`Warning: ${tagged} releases will point at rewritten tags.`);
    await confirmName(args.repo, args.confirm);
    await push(ctx, config, args.repo, sshRemote(config.owner, args.repo));
  }),
});

const verify = defineCommand({
  meta: { name: "verify", description: "Search GitHub again for each old address" },
  run: guarded(async () => {
    const config = await loadConfig(configPath());
    const { byRepo, totals } = await searchAll(config);
    console.log(table(["email", "search", "commits found"], totals));
    const names = Object.keys(byRepo).sort();
    if (names.length > 0) {
      console.log("");
      console.log(
        table(
          ["repo", "commits"],
          names.map((name) => [name, byRepo[name] ?? 0]),
        ),
      );
      console.log("\nThe search index can lag behind a push by hours: run verify again later.");
      process.exitCode = EXIT_REMAINING;
    }
  }),
});

const main = defineCommand({
  meta: {
    name: "purge-git",
    version: CLI_VERSION,
    description: "Rewrite old email addresses out of your GitHub repositories' history",
  },
  subCommands: { init, inventory, "dry-run": dryRunCommand, push: pushCommand, verify },
});

runMain(main);
