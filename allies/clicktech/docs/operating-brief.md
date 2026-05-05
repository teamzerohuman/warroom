# ClickTech Operating Brief

## Scope

ClickTech is an enterprise ally. War Room supports ClickTech work through a local ally workspace, local-only environment files, shared internal documentation, and a dedicated issue repository for client-visible progress sync.

## Shared Context

- Ally id: `clicktech`
- Ally workspace: `allies/clicktech`
- Issue sync boundary: `TeamFloPay/ally-clicktech`
- Client system: Jira
- Sync adapter: Unito
- Current integration focus: Stripe account/API-key workflows

## Handling Rules

- Commit only safe operating context and internal implementation notes suitable for the private War Room repo.
- Keep real API keys in `allies/clicktech/.env.local`.
- Keep raw client exports, production data, private endpoints, contracts, and PII out of git.
- Reference sensitive external material by approved storage label or safe internal link rather than copying it here.
- Product source changes remain in the owning child repo, not in the ally workspace.
