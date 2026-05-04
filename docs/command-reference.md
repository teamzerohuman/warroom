# Command Reference

Phase 1 provides a small CLI skeleton for validation and discovery. Full workflow automation is tracked by later War Room issues.

## Available

```sh
warroom --help
warroom maps study
warroom doctor
warroom dev status
warroom dev link
warroom dev unlink
```

## Stubbed For Later

- `warroom bootstrap`
- `warroom sync`
- `warroom maps assign`
- `warroom issue triage`
- `warroom issue next`
- `warroom pr engage`
- `warroom pr review`
- `warroom pr merge`
- `warroom commit create`
- `warroom abort`

Stubbed commands should fail clearly until their implementation issue is active.

## SDK-To-Demo Local Linking

`warroom dev link` builds the local SDK packages and replaces the demo repo's installed `node_modules/@flopay/*` package symlinks with links to War Room package mirrors under `.warroom/dev/sdk-packages/*`. Each mirror keeps package metadata local and points its `dist` directory at `sdk/packages/*/dist`, so the demo consumes built SDK output without editing committed demo dependencies or the demo lockfile.

Run the linked demo normally:

```sh
corepack pnpm dev
```

Useful validation commands from the demo repo:

```sh
corepack pnpm build
corepack pnpm typecheck
corepack pnpm test:e2e:core
```

Use `warroom dev unlink` to remove local links and run `pnpm install --frozen-lockfile` in the demo repo, restoring published-package behavior.
