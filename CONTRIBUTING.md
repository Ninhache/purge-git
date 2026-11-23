# Contributing

```sh
pnpm install
pnpm test
pnpm lint
pnpm typecheck
```

Tests build throwaway repositories and a local bare remote: no network. Use `@example.com` addresses only;
`pnpm scan-emails <paths>` fails on any other address (allowed: `@example.com`, `@users.noreply.github.com`,
`git@github.com`).

## Release

Bump `version` in `package.json`, merge, then push a `v<version>` tag. The Release workflow publishes to npm
through trusted publishing (no token: set the trusted publisher on npmjs.com, package Settings) after scanning
`dist` and the tarball for email addresses, then creates the GitHub Release with generated notes.
