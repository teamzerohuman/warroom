# ClickTech Issue Sync

## Model

ClickTech Jira issues sync through Unito into the dedicated GitHub issue repo `TeamFloPay/ally-clicktech`.

That repo is the client-facing issue boundary. It lets ClickTech see realtime progress without exposing Flo product repositories such as `backend`, `sdk`, `dashboard`, or `infra`.

## Flow

```text
ClickTech Jira
  <> Unito
TeamFloPay/ally-clicktech GitHub Issues
  -> War Room triage
  -> Campaign Map project board
  -> owning Flo product repos when implementation is needed
```

## Rules

- Search before creating or syncing duplicates.
- Keep client-facing issue titles and comments clear, factual, and free of internal-only implementation noise.
- Keep Campaign Map workflow labels on `TeamFloPay/ally-clicktech`: `needs-triage`, `ready-to-engage`, `battlefield-active`, `skirmish`, `blockaded`, and `victory`.
- Keep client boundary labels on `TeamFloPay/ally-clicktech`: `ally` and `clicktech`.
- Link implementation issues or PRs from owning product repos when useful, but do not expose private details the client should not see.
- Use Campaign Map statuses for internal operating state: `needs-triage`, `ready-to-engage`, `battlefield-active`, `skirmish`, `blockaded`, and `victory`.
- When work moves to a product repo, preserve the client issue as the progress update surface.
