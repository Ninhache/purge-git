#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { defineCommand, runMain } from "citty";
import { type Config, configState, loadConfig, writeConfig, writeTemplate } from "./config";
import { EXIT_ERROR, EXIT_REMAINING, PurgeError } from "./errors";
import { run } from "./exec";
import { filterRepoVersion, scan } from "./git";
import {
  openPullRequests,
  ownedRepos,
  protections,
  type Repo,
  releases,
  type SearchField,
  searchCommits,
} from "./github";
import { discoverConfig } from "./init";
import {
  type Context,
  dryRun,
  freshClone,
  type InventoryRow,
  push,
  readInventory,
  saveInventory,
} from "./ops";
import { cacheRoot, configPath, sshRemote } from "./paths";
import { confirmLocal, pick, pickEmails, pickOrgs } from "./prompt";
import { table } from "./table";
import { labelOf, owners, type Target, targetOf, withOrgs } from "./target";
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
  const loaded = await loadConfig(configPath());
  if (!(await filterRepoVersion(run))) {
    throw new PurgeError(
      "git filter-repo is missing. Install it: `pacman -S git-filter-repo`, `brew install git-filter-repo` or `pipx install git-filter-repo`.",
    );
  }
  const ctx = context();
  return { ctx, config: await withOrgs(run, loaded, ctx.log) };
}

async function writableRepo(config: Config, value: string): Promise<Target> {
  const target = targetOf(config, value);
  const found = (await ownedRepos(run, target.owner)).find((item) => item.name === target.name);
  if (!found) {
    throw new PurgeError(
      `${target.owner}/${target.name} is not a repo you can push to (forks and archived repos are left out).`,
    );
  }
  return target;
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
  const prefixes = owners(config).map((owner) => `${owner.toLowerCase()}/`);
  return Object.keys(byRepo)
    .filter((name) => !prefixes.some((prefix) => name.toLowerCase().startsWith(prefix)))
    .sort();
}

const init = defineCommand({
  meta: { name: "init", description: "Find your old addresses with gh and write the config" },
  args: {
    template: { type: "boolean", description: "Only write a template to fill in by hand" },
    force: { type: "boolean", description: "Replace a config you already filled in" },
  },
  run: guarded(async ({ args }) => {
    const path = configPath();
    if (args.template) {
      const created = await writeTemplate(path);
      console.log(created ? `Wrote ${path}. Fill it in.` : `${path} already exists.`);
      return;
    }
    if ((await configState(path)) === "custom" && !args.force) {
      throw new PurgeError(`${path} already exists. Pass --force to replace it.`);
    }
    if (!process.stdin.isTTY) {
      throw new PurgeError(
        "init asks which addresses to rewrite: run it in a terminal, or use --template.",
      );
    }
    const config = await discoverConfig({
      ctx: context(),
      sleep,
      confirmLocal,
      pickEmails,
      pickOrgs,
    });
    await writeConfig(path, config);
    console.log(
      `Wrote ${path} (mode 0600) with ${config.oldEmails.length} addresses to rewrite. Next: purge-git inventory`,
    );
  }),
});

const inventory = defineCommand({
  meta: { name: "inventory", description: "Read-only: count old addresses in each of your repos" },
  args: {
    repo: { type: "string", description: "Only this repo (org/name for an org repo)" },
  },
  run: guarded(async ({ args }) => {
    const { ctx, config } = await setup();
    const only = args.repo ? targetOf(config, args.repo) : undefined;
    const repos: (Target & Repo)[] = [];
    for (const owner of only ? [only.owner] : owners(config)) {
      for (const item of await ownedRepos(run, owner)) {
        if (only && item.name !== only.name) continue;
        repos.push({ ...item, owner, label: labelOf(config, owner, item.name) });
      }
    }
    const { byRepo, totals } = await searchAll(config);
    console.log(table(["email", "search", "commits found"], totals));
    console.log("");
    const rows: InventoryRow[] = [];
    let clean = 0;
    const failed: string[] = [];
    for (const item of repos) {
      ctx.log(`Scanning ${item.label}...`);
      try {
        const clone = await freshClone(
          ctx,
          item.label,
          sshRemote(item.owner, item.name),
          "inventory",
        );
        const result = await scan(run, clone, config.oldEmails);
        if (result.matching === 0 && result.matchingTags === 0) {
          clean += 1;
          continue;
        }
        const guard = await protections(run, item.owner, item.name);
        rows.push({
          name: item.label,
          commits: result.matching,
          tags: result.matchingTags,
          defaultBranch: item.defaultBranch,
          protected:
            [...guard.branches, ...guard.rulesets.map((name) => `ruleset:${name}`)].join(",") ||
            (guard.unknown ? "?" : "-"),
          visibility: item.visibility,
          openPullRequests: await openPullRequests(run, item.owner, item.name),
          releases: await releases(run, item.owner, item.name),
          signedLost: result.signedLost,
        });
      } catch (error) {
        failed.push(`  ${item.label}: ${error instanceof Error ? error.message : String(error)}`);
      }
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
        rows.map((row) => [
          row.name,
          row.commits,
          row.tags,
          row.defaultBranch,
          row.protected,
          row.visibility,
          row.openPullRequests,
          row.releases,
          row.signedLost,
        ]),
      ),
    );
    if (!args.repo) await saveInventory(ctx, rows);
    console.log(`\n${rows.length} repos to rewrite, ${clean} clean, ${failed.length} failed.`);
    if (failed.length > 0) {
      console.log(`\nCould not scan:\n${failed.join("\n")}`);
      process.exitCode = EXIT_ERROR;
    }
    const others = othersOf(config, byRepo);
    if (others.length > 0) {
      console.log("\nRepos you don't own with an old address (ask their owners):");
      for (const name of others) console.log(`  ${name} (${byRepo[name]} commits)`);
    }
  }),
});

function repoHint(row: InventoryRow): string {
  const extras = [
    row.protected !== "-" ? `protected: ${row.protected}` : "",
    row.openPullRequests > 0 ? `${row.openPullRequests} open PRs` : "",
    row.releases > 0 ? `${row.releases} releases` : "",
  ].filter(Boolean);
  return [`${row.commits} commits, ${row.tags} tags`, ...extras].join(" · ");
}

async function pickRepos(ctx: Context): Promise<string[]> {
  if (!process.stdin.isTTY) throw new PurgeError("Name the repo: purge-git dry-run <repo>.");
  const rows = await readInventory(ctx);
  if (rows.length === 0) throw new PurgeError("The last inventory found nothing to rewrite.");
  const picked = await pick(
    "Which repos should be dry-run? (space to tick, enter to confirm; nothing is pushed)",
    [...rows]
      .sort((a, b) => a.commits - b.commits || a.name.localeCompare(b.name))
      .map((row) => ({ value: row.name, label: row.name, hint: repoHint(row) })),
  );
  if (picked === null || picked.length === 0) throw new PurgeError("No repo picked.");
  return picked;
}

const dryRunCommand = defineCommand({
  meta: { name: "dry-run", description: "Rewrite a fresh clone and prove no old address is left" },
  args: {
    repo: {
      type: "positional",
      required: false,
      description:
        "Repository name, org/name for an org repo (omit to pick from the last inventory)",
    },
  },
  run: guarded(async ({ args }) => {
    const { ctx, config } = await setup();
    const names = args.repo ? [args.repo] : await pickRepos(ctx);
    const failed: string[] = [];
    const ready: string[] = [];
    for (const name of names) {
      try {
        const target = await writableRepo(config, name);
        const result = await dryRun(
          ctx,
          config,
          target.label,
          sshRemote(target.owner, target.name),
        );
        if (result.left > 0) {
          failed.push(name);
          process.exitCode = EXIT_REMAINING;
        } else if (result.after) {
          ready.push(target.label);
        }
      } catch (error) {
        if (names.length === 1) throw error;
        console.error(error instanceof Error ? error.message : String(error));
        failed.push(name);
        process.exitCode ||= EXIT_ERROR;
      }
      if (names.length > 1) console.log("");
    }
    if (ready.length > 0) {
      console.log(
        `Ready to push, one at a time:\n${ready.map((name) => `  purge-git push ${name} --confirm ${name}`).join("\n")}`,
      );
    }
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
    repo: {
      type: "positional",
      required: true,
      description: "Repository name, org/name for an org repo",
    },
    confirm: { type: "string", description: "Repeat the repository name" },
    "dry-run": {
      type: "boolean",
      description: "Show what the push would change, without sending anything",
    },
  },
  run: guarded(async ({ args }) => {
    const { ctx, config } = await setup();
    const target = await writableRepo(config, args.repo);
    const guard = await protections(run, target.owner, target.name);
    const prs = await openPullRequests(run, target.owner, target.name);
    const tagged = await releases(run, target.owner, target.name);
    if (guard.branches.length > 0) console.log(`Protected branches: ${guard.branches.join(", ")}`);
    if (guard.rulesets.length > 0) console.log(`Active rulesets: ${guard.rulesets.join(", ")}`);
    if (prs > 0)
      console.log(`Warning: ${prs} open PRs will no longer match the rewritten history.`);
    if (tagged > 0) console.log(`Warning: ${tagged} releases will point at rewritten tags.`);
    if (target.owner !== config.owner) {
      console.log(
        `Warning: ${target.owner} is an organization. Every other member's clone of ${target.name} will stop matching: tell them to clone it again.`,
      );
    }
    const url = sshRemote(target.owner, target.name);
    if (args["dry-run"]) {
      await push(ctx, config, target.label, url, { dryRun: true });
      return;
    }
    const confirmed = args.confirm === undefined ? undefined : targetOf(config, args.confirm).label;
    await confirmName(target.label, confirmed);
    await push(ctx, config, target.label, url);
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
