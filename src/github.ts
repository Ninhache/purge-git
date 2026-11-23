import { type Run, runOk } from "./exec";

export interface Repo {
  name: string;
  visibility: string;
  defaultBranch: string;
}

const SEARCH_PAGE_SIZE = 100;
const SEARCH_MAX_PAGES = 10;
const RATE_LIMIT_WAIT_MS = 61_000;

export async function ownedRepos(runner: Run, owner: string): Promise<Repo[]> {
  const out = await runOk(runner, "gh", [
    "repo",
    "list",
    owner,
    "--source",
    "--no-archived",
    "--limit",
    "1000",
    "--json",
    "name,visibility,defaultBranchRef,isFork,isArchived",
  ]);
  const rows = JSON.parse(out) as {
    name: string;
    visibility: string;
    defaultBranchRef: { name: string } | null;
    isFork: boolean;
    isArchived: boolean;
  }[];
  return rows
    .filter((row) => !row.isFork && !row.isArchived)
    .map((row) => ({
      name: row.name,
      visibility: row.visibility.toLowerCase(),
      defaultBranch: row.defaultBranchRef?.name ?? "",
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export type SearchField = "author-email" | "committer-email";

export interface SearchHits {
  total: number;
  byRepo: Record<string, number>;
}

export async function searchCommits(
  runner: Run,
  field: SearchField,
  email: string,
  sleep: (ms: number) => Promise<void>,
): Promise<SearchHits> {
  const found = await searchPages(runner, { q: `${field}:${email}` }, sleep);
  const hits: SearchHits = { total: found.total, byRepo: {} };
  for (const item of found.items as { repository: { full_name: string } }[]) {
    const name = item.repository.full_name;
    hits.byRepo[name] = (hits.byRepo[name] ?? 0) + 1;
  }
  return hits;
}

export interface SearchResult {
  total: number;
  items: unknown[];
}

export async function searchPages(
  runner: Run,
  params: Record<string, string>,
  sleep: (ms: number) => Promise<void>,
): Promise<SearchResult> {
  const found: SearchResult = { total: 0, items: [] };
  const fields = Object.entries(params).flatMap(([key, value]) => ["-f", `${key}=${value}`]);
  for (let page = 1; page <= SEARCH_MAX_PAGES; page += 1) {
    const args = [
      "api",
      "-X",
      "GET",
      "search/commits",
      ...fields,
      "-f",
      `per_page=${SEARCH_PAGE_SIZE}`,
      "-f",
      `page=${page}`,
    ];
    let result = await runner("gh", args);
    if (result.code !== 0 && /rate limit/i.test(result.stderr + result.stdout)) {
      await sleep(RATE_LIMIT_WAIT_MS);
      result = await runner("gh", args);
    }
    if (result.code !== 0) throw new Error(`gh search failed: ${result.stderr.trim()}`);
    const body = JSON.parse(result.stdout) as { total_count: number; items: unknown[] };
    found.total = body.total_count;
    found.items.push(...body.items);
    if (body.items.length < SEARCH_PAGE_SIZE) break;
  }
  return found;
}

export interface Protections {
  branches: string[];
  rulesets: string[];
  unknown: boolean;
}

export async function protections(runner: Run, owner: string, repo: string): Promise<Protections> {
  const branches = await runner("gh", [
    "api",
    "--paginate",
    `repos/${owner}/${repo}/branches?protected=true&per_page=100`,
    "--jq",
    ".[].name",
  ]);
  const rulesets = await runner("gh", [
    "api",
    "--paginate",
    `repos/${owner}/${repo}/rulesets?per_page=100`,
    "--jq",
    '.[] | select(.enforcement != "disabled") | .name',
  ]);
  return {
    branches: branches.code === 0 ? lines(branches.stdout) : [],
    rulesets: rulesets.code === 0 ? lines(rulesets.stdout) : [],
    unknown: branches.code !== 0 || rulesets.code !== 0,
  };
}

export async function openPullRequests(runner: Run, owner: string, repo: string): Promise<number> {
  const out = await runOk(runner, "gh", [
    "pr",
    "list",
    "-R",
    `${owner}/${repo}`,
    "--state",
    "open",
    "--limit",
    "1000",
    "--json",
    "number",
  ]);
  return (JSON.parse(out) as unknown[]).length;
}

export async function releases(runner: Run, owner: string, repo: string): Promise<number> {
  const out = await runOk(runner, "gh", [
    "release",
    "list",
    "-R",
    `${owner}/${repo}`,
    "--limit",
    "1000",
    "--json",
    "tagName",
  ]);
  return (JSON.parse(out) as unknown[]).length;
}

function lines(out: string): string[] {
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}
