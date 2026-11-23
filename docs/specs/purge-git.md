# purge-git

CLI that rewrites old personal email addresses out of the history of the GitHub repositories you own,
with `git filter-repo`, one approved repository at a time. Published on npm as `@ninhache/purge-git`.

## Config

`~/.config/purge-git/config.json` (override: `PURGE_GIT_CONFIG`), mode 0600, never in a repository:

```json
{
  "owner": "Ninhache",
  "identity": { "name": "Ninhache", "email": "1234+Ninhache@users.noreply.github.com" },
  "oldEmails": ["old@example.com"]
}
```

`purge-git init` writes a template with placeholders. The tool refuses a config file readable by others.
Work dir: `~/.cache/purge-git` (override: `PURGE_GIT_CACHE`), mode 0700, one mirror clone per repository.

## Commands

| Command                        | Effect                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inventory`                    | Read-only. Lists owned repos (not forks, not archived), runs the commit search per old address, mirror-clones each owned repo into its own `inventory.git` (the dry-run clone is kept), counts matches locally, prints a table. A repo that fails is reported and the others go on. Lists repos owned by others that the search found. |
| `dry-run <repo>`               | Rewrites the cached clone, prints before/after counts per email, proves no old address is left, writes a verified marker.                                                                                                                                                                                                              |
| `push <repo> --confirm <repo>` | Pushes a verified rewrite: `--force --all`, then `--force --tags`.                                                                                                                                                                                                                                                                     |
| `verify`                       | Commit search again for each old address, prints what is left.                                                                                                                                                                                                                                                                         |

### Inventory table

repo, matching commits, default branch, protected branches (classic protection and rulesets), visibility,
open PRs, releases, signed commits that would lose their signature.

### Dry run

1. Fresh mirror clone (the previous one is replaced). Records the pre-rewrite refs (`for-each-ref`).
2. `git filter-repo --mailmap <file> --replace-message <file>` in one pass: one mailmap line per old address mapped to the identity, one case-insensitive `regex:` rule per old address for commit and tag messages.
3. Proof: no old address in `%ae %ce` over every branch and tag (the refs that get pushed), in commit messages, in tagger emails, in tag messages.
4. Marker `verified.json`: pre-rewrite refs, post-rewrite counts, timestamp.

### Push guards

- The verified marker exists and its proof passed.
- `--confirm` equals the repository name, otherwise an interactive prompt asks to type it.
- `git ls-remote` of the remote has the same heads and tags as before the rewrite, each at its pre- or
  post-rewrite SHA (a refused push can be retried), otherwise abort: someone pushed.
- Remote is `git@github.com:<owner>/<repo>.git` (SSH, no token).
- A refused push prints the protection or ruleset to lift and stops. The tool never changes a protection.
- Open PRs and releases are listed as a warning before the push.

## Privacy

- Old addresses only come from the config file. No address is hardcoded in source, tests or docs.
- Tests and fixtures use `@example.com`.
- The `gh` token is never read, printed or put in a URL; `gh` handles it.
- CI scans `dist/` and the packed tarball for email addresses outside an allowlist before publishing.

## Limits

- Rewriting a commit changes every descendant's SHA: signatures on those commits are stripped
  (filter-repo 2.47), signed tags become annotated tags. `inventory` counts them.
- `refs/pull/*` cannot be pushed: old SHAs stay reachable on GitHub until GitHub Support purges them.
- Forks, clones, GH Archive, Software Heritage: out of reach.
- The commit search caps at 1,000 results per query: the local count is the source of truth.

## Exit codes

0 ok, 1 error, 2 old addresses still present (dry-run proof or verify).
