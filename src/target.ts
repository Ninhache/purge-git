import { type Config, isRepoName } from "./config";
import { PurgeError } from "./errors";
import type { Run } from "./exec";
import { userOrgs } from "./github";

export interface Target {
  owner: string;
  name: string;
  label: string;
}

export function labelOf(config: Config, owner: string, name: string): string {
  return owner.toLowerCase() === config.owner.toLowerCase() ? name : `${owner}/${name}`;
}

export function targetOf(config: Config, value: string): Target {
  const parts = value.split("/");
  const [owner, name] = parts.length === 2 ? parts : [config.owner, value];
  if (parts.length > 2 || !owner || !name || !isRepoName(owner) || !isRepoName(name)) {
    throw new PurgeError(`Not a repository name: ${value}`);
  }
  const known = owners(config).find((candidate) => candidate.toLowerCase() === owner.toLowerCase());
  if (!known) {
    throw new PurgeError(
      `${owner} is neither you nor one of the orgs in your config. Add it to "orgs" first.`,
    );
  }
  return { owner: known, name, label: labelOf(config, known, name) };
}

export function owners(config: Config): string[] {
  return [config.owner, ...(config.orgs ?? [])];
}

export async function withOrgs(
  runner: Run,
  config: Config,
  log: (line: string) => void,
): Promise<Config> {
  if (config.orgs) return config;
  const orgs = await userOrgs(runner);
  if (orgs === null) {
    log(
      "Your organizations are left out: gh needs the read:org scope (`gh auth refresh -h github.com -s read:org`).",
    );
  }
  return { ...config, orgs: orgs ?? [] };
}
