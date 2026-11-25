import { PurgeError } from "./errors";
import { type Run, runOk } from "./exec";

export interface SignResult {
  signed: number;
  recreated: number;
  othersLost: number;
  tagsMoved: number;
}

interface Entry {
  sha: string;
  parents: string[];
  committer: string;
  status: string;
}

const FIELD = "\u0000";
const IDENT = /^(.*) <(.*)> (\d+ [+-]\d{4})$/;
const SIGNATURE = /-----BEGIN (PGP|SSH) SIGNATURE-----[\s\S]*$/;

async function history(runner: Run, dir: string): Promise<Entry[]> {
  const out = await runOk(runner, "git", [
    "-C",
    dir,
    "log",
    "--branches",
    "--tags",
    "--topo-order",
    "--reverse",
    "--format=%H%x00%P%x00%ce%x00%G?",
  ]);
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha = "", parents = "", committer = "", status = "N"] = line.split(FIELD);
      return {
        sha,
        parents: parents.split(" ").filter(Boolean),
        committer: committer.toLowerCase(),
        status,
      };
    });
}

async function hasCommits(runner: Run, dir: string): Promise<boolean> {
  const result = await runner("git", ["-C", dir, "rev-parse", "--verify", "--quiet", "HEAD"]);
  const refs = await runOk(runner, "git", ["-C", dir, "for-each-ref", "refs/heads", "refs/tags"]);
  return result.code === 0 || refs.trim() !== "";
}

const GOOD = new Set(["G", "U"]);

export async function unsignedMine(runner: Run, dir: string, email: string): Promise<number> {
  if (!(await hasCommits(runner, dir))) return 0;
  const mine = email.toLowerCase();
  return (await history(runner, dir)).filter(
    (entry) => entry.committer === mine && !GOOD.has(entry.status),
  ).length;
}

function identity(line: string, field: string): Record<string, string> {
  const match = IDENT.exec(line);
  if (!match) throw new PurgeError(`Cannot read the ${field} line: ${line}`);
  const [, name = "", email = "", date = ""] = match;
  const key = field.toUpperCase();
  return { [`GIT_${key}_NAME`]: name, [`GIT_${key}_EMAIL`]: email, [`GIT_${key}_DATE`]: date };
}

async function recreate(
  runner: Run,
  dir: string,
  sha: string,
  parents: string[],
  sign: boolean,
): Promise<string> {
  const raw = await runOk(runner, "git", ["-C", dir, "cat-file", "commit", sha]);
  const split = raw.indexOf("\n\n");
  const headers = (split === -1 ? raw : raw.slice(0, split)).split("\n");
  const message = split === -1 ? "" : raw.slice(split + 2);
  const header = (name: string) =>
    headers.find((line) => line.startsWith(`${name} `))?.slice(name.length + 1);
  if (header("encoding")) {
    throw new PurgeError(`Commit ${sha.slice(0, 7)} declares an encoding: it cannot be re-signed.`);
  }
  const tree = header("tree");
  const author = header("author");
  const committer = header("committer");
  if (!tree || !author || !committer) throw new PurgeError(`Cannot read commit ${sha}.`);
  const args = ["-C", dir, "commit-tree", tree, ...parents.flatMap((parent) => ["-p", parent])];
  const result = await runner("git", sign ? [...args, "-S"] : args, {
    input: message,
    env: { ...identity(author, "author"), ...identity(committer, "committer") },
  });
  if (result.code !== 0) {
    throw new PurgeError(
      `Signing failed: ${result.stderr.trim()}\nUnlock your key (for gpg: \`echo test | gpg --clearsign >/dev/null\`) and check git's user.signingkey, then run the dry run again.`,
    );
  }
  return result.stdout.trim();
}

async function moveRefs(runner: Run, dir: string, moved: Map<string, string>): Promise<number> {
  const out = await runOk(runner, "git", [
    "-C",
    dir,
    "for-each-ref",
    "--format=%(objectname)%00%(objecttype)%00%(*objectname)%00%(refname)",
    "refs/heads",
    "refs/tags",
  ]);
  let tags = 0;
  for (const line of out.split("\n").filter(Boolean)) {
    const [object = "", type = "", peeled = "", ref = ""] = line.split(FIELD);
    if (type === "commit") {
      const target = moved.get(object);
      if (target) await runOk(runner, "git", ["-C", dir, "update-ref", ref, target, object]);
      continue;
    }
    const target = type === "tag" ? moved.get(peeled) : undefined;
    if (!target) continue;
    const raw = await runOk(runner, "git", ["-C", dir, "cat-file", "tag", object]);
    if (!raw.startsWith(`object ${peeled}\n`)) continue;
    const retargeted = `object ${target}\n${raw.slice(`object ${peeled}\n`.length)}`.replace(
      SIGNATURE,
      "",
    );
    const tag = (
      await runOk(runner, "git", ["-C", dir, "hash-object", "-t", "tag", "-w", "--stdin"], {
        input: retargeted,
      })
    ).trim();
    await runOk(runner, "git", ["-C", dir, "update-ref", ref, tag, object]);
    tags += 1;
  }
  return tags;
}

export async function signMine(runner: Run, dir: string, email: string): Promise<SignResult> {
  const result: SignResult = { signed: 0, recreated: 0, othersLost: 0, tagsMoved: 0 };
  if (!(await hasCommits(runner, dir))) return result;
  const mine = email.toLowerCase();
  const moved = new Map<string, string>();
  for (const entry of await history(runner, dir)) {
    const parents = entry.parents.map((parent) => moved.get(parent) ?? parent);
    const parentsMoved = parents.some((parent, index) => parent !== entry.parents[index]);
    const ours = entry.committer === mine;
    if (!parentsMoved && (!ours || GOOD.has(entry.status))) continue;
    moved.set(entry.sha, await recreate(runner, dir, entry.sha, parents, ours));
    result.recreated += 1;
    if (ours) result.signed += 1;
    else if (entry.status !== "N") result.othersLost += 1;
  }
  result.tagsMoved = await moveRefs(runner, dir, moved);
  return result;
}
