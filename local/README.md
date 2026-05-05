# Local Orchestration

This directory is for local-only cross-repo helpers such as Caddy routes and Docker Compose wrappers.

Live/deployable infrastructure remains owned by the `TeamFloPay/infra` repository.

SDK-to-demo package linking is implemented by the War Room CLI:

```sh
npm run warroom -- dev status
npm run warroom -- dev link
npm run warroom -- dev unlink
```

Enterprise ally local state belongs under `../allies/<ally>/workspace/*` and `../allies/<ally>/repos/*`. Those paths are ignored because they may contain client-specific scratch work or client issue repo checkouts.
