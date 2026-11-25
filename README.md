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
4. the organizations you belong to (needs the `read:org` scope, which `gh` has by default), all ticked: untick
   the ones to leave alone. Only repos you can push to are used;
5. if you accept, the addresses in every repo you own or in a ticked org, cloned locally. This finds addresses removed from
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
read it. Without `orgs`, every organization you belong to is included, with the repos you can push to.
`"orgs": ["your-org"]` limits it to those, and `"orgs": []` leaves them all out. `init` writes the list only when
you untick one.

Lines that tools add to commit messages are removed too: `Claude-Session:` lines, `Co-Authored-By:` lines naming
an AI tool (Claude, Copilot, Cursor, Codex, Gemini…) and `Generated with Claude Code`. The subject line is never
touched. `"stripLines": ["^Internal:", "@ai"]` sets your own patterns (case-insensitive regexes, matched anywhere in
a line), `"@ai"` keeps the built-in ones, and `"stripLines": []` turns it off.

An org repo is named `org/name` in every command (`purge-git dry-run your-org/app`); your own repos keep their
bare name. Pushing one rewrites history every other member shares: they all have to clone it again.

## Commands

| Command                                  | What it does                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `purge-git inventory [--repo <name>]`    | Read-only. Searches GitHub for commits with each old address, mirror-clones your own repos (not forks, not archived) and counts matching commits and tags. Prints default branch, protections, rulesets, visibility, open PRs, releases and how many signed commits would lose their signature. Lists repos owned by others where an address shows up.        |
| `purge-git dry-run [repo]`               | Without a name, lists the repos the last `inventory` found and dry-runs the ones you tick. Rewrites a fresh mirror clone (authors, committers, commit and tag messages, taggers), prints the before/after counts per address and proves none is left. Saves the original history as a bundle first. `--sign` signs your rewritten commits. Nothing is pushed. |
| `purge-git push <repo> --confirm <repo>` | Force-pushes a verified dry run: every branch, then every tag. Refuses when the remote moved since the dry run or the backup is gone. Without `--confirm`, asks you to type the name. `--dry-run` runs the same checks and lists each branch and tag with its old and new SHA, without sending anything.                                                      |
| `purge-git verify`                       | Runs the GitHub search again and reports what is left.                                                                                                                                                                                                                                                                                                        |

Clones live in `~/.cache/purge-git` (mode 0700; `PURGE_GIT_CACHE` overrides it).
Reports name old addresses by their place in `oldEmails` (`old address #1`, …), so their output can be shared.
Exit codes: `0` ok, `1` error, `2` old addresses still present.

## Before you push

- Every rewritten commit, and every commit after it, gets a new SHA: links to old commits and open PRs break,
  and signatures on those commits are dropped. `inventory` counts them. `dry-run --sign` signs again the rewritten
  commits you committed, with your git signing key (unlock it first, e.g. `echo test | gpg --clearsign >/dev/null`);
  the proof then checks each of them has a good signature.
- Each dry run saves the original history to `~/.cache/purge-git/<repo>/backups/<time>.bundle` (mode 0600)
  and never deletes one. To restore: `git clone --mirror <bundle> restore.git`, then from `restore.git`
  `git push --force --all <remote>` and `git push --force --tags <remote>`.
- A push refused by a branch protection or a ruleset stops with what to lift. The tool never changes one.
- Turn on GitHub's "Block command line pushes that expose my email": a push that still contains a private
  address is refused (GH007).
- `refs/pull/*`, forks, other people's clones and archives keep the old history: ask GitHub Support to purge
  cached views if needed.

## License

MIT
