# purge-git

Rewrite old email addresses out of the history of the GitHub repositories you own, with
[`git filter-repo`](https://github.com/newren/git-filter-repo), one approved repository at a time.

```sh
npm install -g @ninhache/purge-git
```

Needs Node >= 22, `git`, `git filter-repo` and an authenticated [`gh`](https://cli.github.com).
Pushes go over SSH (`git@github.com:<owner>/<repo>.git`).

## Config

```sh
purge-git init
```

asks `gh` who you are and finds the addresses to rewrite:

1. your login, and your noreply address `<id>+<login>@users.noreply.github.com` as the new identity;
2. the addresses on your GitHub account, when `gh` has the read-only `user:email` scope (`gh auth refresh -h github.com -s user:email`);
3. the addresses in the commits GitHub links to you (commit search, oldest and newest 1000);
4. if you accept, the addresses in every repo you own, cloned locally. This finds addresses removed from
   your account, which GitHub no longer links to you. Addresses used under other names come last, unticked.

You tick the ones to rewrite in a list (searchable when it is long). Addresses found on GitHub are ticked
first. It writes `~/.config/purge-git/config.json` (mode 0600; `PURGE_GIT_CONFIG` overrides the path):

```json
{
  "owner": "your-login",
  "identity": { "name": "Your Name", "email": "12345+your-login@users.noreply.github.com" },
  "oldEmails": ["old@example.com"]
}
```

`init --template` writes that template to fill in by hand instead, and `init --force` replaces a config you
already filled in. The addresses stay in that file: never commit it. The tool refuses it when other users can
read it.

## Commands

| Command                                  | What it does                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `purge-git inventory [--repo <name>]`    | Read-only. Searches GitHub for commits with each old address, mirror-clones your own repos (not forks, not archived) and counts matching commits and tags. Prints default branch, protections, rulesets, visibility, open PRs, releases and how many signed commits would lose their signature. Lists repos owned by others where an address shows up. |
| `purge-git dry-run <repo>`               | Rewrites a fresh mirror clone (authors, committers, commit and tag messages, taggers), prints the before/after counts per address and proves none is left. Nothing is pushed.                                                                                                                                                                          |
| `purge-git push <repo> --confirm <repo>` | Force-pushes a verified dry run: every branch, then every tag. Refuses when the remote moved since the dry run. Without `--confirm`, asks you to type the name.                                                                                                                                                                                        |
| `purge-git verify`                       | Runs the GitHub search again and reports what is left.                                                                                                                                                                                                                                                                                                 |

Clones live in `~/.cache/purge-git` (mode 0700; `PURGE_GIT_CACHE` overrides it).
Exit codes: `0` ok, `1` error, `2` old addresses still present.

## Before you push

- Every rewritten commit, and every commit after it, gets a new SHA: links to old commits and open PRs break,
  and signatures on those commits are dropped. `inventory` counts them.
- A push refused by a branch protection or a ruleset stops with what to lift. The tool never changes one.
- Turn on GitHub's "Block command line pushes that expose my email": a push that still contains a private
  address is refused (GH007).
- `refs/pull/*`, forks, other people's clones and archives keep the old history: ask GitHub Support to purge
  cached views if needed.

## License

MIT
