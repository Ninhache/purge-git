import type { Config } from "./config";
import {
  account,
  accountEmails,
  type Candidate,
  candidates,
  localEmails,
  noreplyOf,
  searchedEmails,
  type Tallies,
} from "./discover";
import { PurgeError } from "./errors";
import { ownedRepos } from "./github";
import { type Context, freshClone } from "./ops";
import { sshRemote } from "./paths";

export interface InitDeps {
  ctx: Context;
  sleep: (ms: number) => Promise<void>;
  confirmLocal: (repos: number) => Promise<boolean>;
  pickEmails: (found: Candidate[]) => Promise<string[] | null>;
  remote?: (owner: string, repo: string) => string;
}

export async function discoverConfig(deps: InitDeps): Promise<Config> {
  const { ctx } = deps;
  const user = await account(ctx.run);
  const identity = { name: user.name, email: noreplyOf(user) };
  ctx.log(`Signed in to gh as ${user.login}. New identity: ${identity.name} <${identity.email}>`);
  const tallies: Tallies = new Map();
  if (!(await accountEmails(ctx.run, tallies))) {
    ctx.log(
      "Skipped your account's email list: gh needs the user:email scope (`gh auth refresh -h github.com -s user:email`).",
    );
  }
  const searched = await searchedEmails(ctx.run, user.login, tallies, deps.sleep);
  ctx.log(`Read ${searched.read} of the ${searched.total} commits GitHub links to ${user.login}.`);
  const repos = await ownedRepos(ctx.run, user.login);
  if (await deps.confirmLocal(repos.length)) {
    const remote = deps.remote ?? sshRemote;
    for (const repo of repos) {
      ctx.log(`Reading ${repo.name}...`);
      try {
        const dir = await freshClone(ctx, repo.name, remote(user.login, repo.name), "inventory");
        await localEmails(ctx.run, dir, tallies);
      } catch (error) {
        ctx.log(`  skipped: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  const found = candidates(tallies, user, identity.email);
  if (found.length === 0) {
    throw new PurgeError("No address other than your noreply one was found. Nothing to rewrite.");
  }
  const picked = await deps.pickEmails(found);
  if (picked === null) throw new PurgeError("Cancelled. No config written.");
  if (picked.length === 0) throw new PurgeError("No address picked. No config written.");
  return { owner: user.login, identity, oldEmails: picked };
}
