import { homedir } from "node:os";
import { join } from "node:path";

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PURGE_GIT_CONFIG) return env.PURGE_GIT_CONFIG;
  const base = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "purge-git", "config.json");
}

export function cacheRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PURGE_GIT_CACHE) return env.PURGE_GIT_CACHE;
  const base = env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(base, "purge-git");
}

export function inventoryFile(cache: string): string {
  return join(cache, "@inventory.json");
}

export interface RepoPaths {
  root: string;
  mirror: string;
  inventory: string;
  mailmap: string;
  messages: string;
  marker: string;
}

export function repoPaths(cache: string, repo: string): RepoPaths {
  const root = join(cache, repo);
  return {
    root,
    mirror: join(root, "mirror.git"),
    inventory: join(root, "inventory.git"),
    mailmap: join(root, "mailmap"),
    messages: join(root, "messages"),
    marker: join(root, "verified.json"),
  };
}

export function sshRemote(owner: string, repo: string): string {
  return `git@github.com:${owner}/${repo}.git`;
}
