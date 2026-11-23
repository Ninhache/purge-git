import { type Config, isRepoName } from "./config";
import { PurgeError } from "./errors";

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
  const known = [config.owner, ...config.orgs].find(
    (candidate) => candidate.toLowerCase() === owner.toLowerCase(),
  );
  if (!known) {
    throw new PurgeError(
      `${owner} is neither you nor one of the orgs in your config. Add it to "orgs" first.`,
    );
  }
  return { owner: known, name, label: labelOf(config, known, name) };
}

export function owners(config: Config): string[] {
  return [config.owner, ...config.orgs];
}
