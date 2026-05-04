# Local Development

War Room is a parent workspace for local coordination. It is not required to build or deploy product repositories.

## Install

```sh
npm install
npm run build
npm test
```

## Child Repos

Child repositories should be checked out under `maps/repos/*` by future bootstrap/sync commands. That directory is ignored because child repos commit their work independently.

For now, War Room commands also detect sibling checkouts next to this repository, such as `../sdk` and `../demo`, when the mapped `maps/repos/*` checkout is missing. This keeps existing local clones usable while preserving `repos.yaml` as the ownership map.

Clone child repos manually only if needed:

```sh
git clone git@github.com:TeamFloPay/sdk.git maps/repos/sdk
git clone git@github.com:TeamFloPay/backend.git maps/repos/backend
git clone git@github.com:TeamFloPay/infra.git maps/repos/infra
git clone git@github.com:TeamFloPay/demo.git maps/repos/demo
```

## SDK-To-Demo Linking

Use local linking when you need to change SDK packages and verify those changes in the standalone demo before publishing `@flopay/*`.

Use published package versions when testing normal app install/deploy behavior or when you do not need unreleased SDK code.

### Link

From War Room:

```sh
npm run warroom -- dev status
npm run warroom -- dev link
```

`dev link` builds the SDK packages, then points `demo/node_modules/@flopay/shared`, `@flopay/js`, `@flopay/react`, and `@flopay/node` at generated package mirrors under `.warroom/dev/sdk-packages/*`. Each mirror links its `dist` directory to the matching local SDK package build output. The demo `package.json` and `pnpm-lock.yaml` stay on published semver ranges.

The demo repo must already have dependencies installed:

```sh
cd ../demo
corepack pnpm install
```

### Run

Use one terminal for SDK package watch builds:

```sh
cd ../sdk
corepack pnpm dev
```

Use another terminal for the demo:

```sh
cd ../demo
corepack pnpm dev
```

### Validate

From the demo repo:

```sh
corepack pnpm build
corepack pnpm typecheck
corepack pnpm test:e2e:core
```

For narrower Playwright smoke checks, use the demo repo's existing scripts such as `test:e2e:card`, `test:e2e:buttons-classic`, or `test:e2e:buttons-embedded`.

### Unlink

From War Room:

```sh
npm run warroom -- dev unlink
```

`dev unlink` removes only symlinks owned by this local dev-link workflow, deletes the generated package mirrors, then runs `corepack pnpm install --frozen-lockfile` in the demo repo to restore published-package behavior.
