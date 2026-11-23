import { type Run, runOk } from "./exec";
import { searchPages } from "./github";

export interface Account {
  login: string;
  id: number;
  name: string;
}

export type Source = "account" | "search" | "local";

export interface Candidate {
  email: string;
  commits: number;
  names: string[];
  sources: Source[];
  mine: boolean;
}

interface Tally {
  commits: number;
  names: Set<string>;
  sources: Set<Source>;
}

export type Tallies = Map<string, Tally>;

const SEARCH_ORDERS = ["asc", "desc"] as const;

export async function account(runner: Run): Promise<Account> {
  const out = await runOk(runner, "gh", ["api", "user"]);
  const body = JSON.parse(out) as { login: string; id: number; name: string | null };
  return { login: body.login, id: body.id, name: body.name?.trim() || body.login };
}

export function noreplyOf(user: Account): string {
  return `${user.id}+${user.login}@users.noreply.github.com`;
}

export function tally(tallies: Tallies, email: string, name: string, source: Source, n = 1) {
  const key = email.trim().toLowerCase();
  if (!key.includes("@")) return;
  const entry = tallies.get(key) ?? { commits: 0, names: new Set(), sources: new Set() };
  entry.commits += n;
  if (name.trim()) entry.names.add(name.trim());
  entry.sources.add(source);
  tallies.set(key, entry);
}

export async function accountEmails(runner: Run, tallies: Tallies): Promise<boolean> {
  const result = await runner("gh", ["api", "user/emails"]);
  if (result.code !== 0) return false;
  for (const row of JSON.parse(result.stdout) as { email: string }[]) {
    tally(tallies, row.email, "", "account", 0);
  }
  return true;
}

export async function searchedEmails(
  runner: Run,
  login: string,
  tallies: Tallies,
  sleep: (ms: number) => Promise<void>,
): Promise<{ total: number; read: number }> {
  const seen = new Set<string>();
  let total = 0;
  for (const order of SEARCH_ORDERS) {
    const items = await searchPages(
      runner,
      { q: `author:${login}`, sort: "author-date", order },
      sleep,
    );
    total = items.total;
    for (const item of items.items as SearchCommit[]) {
      if (seen.has(item.sha)) continue;
      seen.add(item.sha);
      tally(tallies, item.commit.author.email, item.commit.author.name, "search");
    }
    if (seen.size >= total) break;
  }
  return { total, read: seen.size };
}

interface SearchCommit {
  sha: string;
  commit: { author: { name: string; email: string } };
}

export async function localEmails(runner: Run, dir: string, tallies: Tallies): Promise<void> {
  const out = await runOk(runner, "git", [
    "-C",
    dir,
    "log",
    "--branches",
    "--tags",
    "--format=%an%x00%ae%x00%cn%x00%ce",
  ]);
  for (const line of out.split("\n")) {
    const [an = "", ae = "", cn = "", ce = ""] = line.split("\u0000");
    if (!ae) continue;
    tally(tallies, ae, an, "local");
    if (ce.toLowerCase() !== ae.toLowerCase()) tally(tallies, ce, cn, "local");
  }
}

export function candidates(tallies: Tallies, user: Account, identity: string): Candidate[] {
  const mine = new Set([user.login.toLowerCase(), user.name.toLowerCase()]);
  for (const [, entry] of tallies) {
    if (entry.sources.has("account") || entry.sources.has("search")) {
      for (const name of entry.names) mine.add(name.toLowerCase());
    }
  }
  const result: Candidate[] = [];
  for (const [email, entry] of tallies) {
    if (email === identity.toLowerCase() || email.endsWith("@users.noreply.github.com")) continue;
    const linked = entry.sources.has("account") || entry.sources.has("search");
    const named = [...entry.names].some((name) => mine.has(name.toLowerCase()));
    result.push({
      email,
      commits: entry.commits,
      names: [...entry.names].sort(),
      sources: [...entry.sources].sort(),
      mine: linked || named,
    });
  }
  const rank = (candidate: Candidate) => (preselected(candidate) ? 0 : candidate.mine ? 1 : 2);
  return result.sort(
    (a, b) => rank(a) - rank(b) || b.commits - a.commits || a.email.localeCompare(b.email),
  );
}

export function preselected(candidate: Candidate): boolean {
  return candidate.sources.includes("account") || candidate.sources.includes("search");
}
