# OpenChangelog Release Notes

War Room can write public release notes for repos that use a self-hosted OpenChangelog local source.

OpenChangelog local-folder mode treats each Markdown file in the configured folder as one release note. Use `repos.yaml` to opt a repo into that format:

```yaml
merge:
  changelog:
    enabled: true
    format: openchangelog
    path: release-notes
    url: https://changelog.sdk.flopay.com
```

Legacy `merge.changelog: true` still means "update `CHANGELOG.md`". New client-facing repos should prefer `format: openchangelog`.

Because these notes are public, `warroom pr merge` asks for explicit changelog approval before launching the adapter in interactive terminals. Non-interactive merges must pass `--confirm-changelog`; otherwise War Room skips the changelog closeout after the PR merge.

When `merge.bump` is enabled, War Room asks whether to run the configured package version bump before PR merge. Approved changelog updates read package versions from the merged bump, so the public release note filename and commit message can use the released version.

Set `url` to the public changelog site. War Room includes that link in the final victory update so the issue closeout points readers to the client-facing changelog.

## File Format

Create one Markdown file per release under the configured folder, usually `release-notes/`.
The frontmatter `title` must start with the release version in `vX.Y.Z - ` format.

Use this structure:

```markdown
---
title: v1.2.3 - Checkout fallback improvements
description: Buyers now see only payment methods that can complete successfully in their browser.
publishedAt: "2026-05-12T09:00:00.000Z"
tags:
  - Improvement
  - Checkout
---

Unsupported wallet options are now hidden automatically when the buyer browser cannot complete those flows. Card checkout remains available so shoppers can continue without extra warning screens.

### What changed

- PayPal and wallet options are shown only when the active browser and payment provider report them as available.
- Checkout falls back to card entry instead of displaying an in-app browser warning.

### Developer notes

- The legacy `InAppBrowserNotice` React export has been removed. Remove direct imports before upgrading.
```

Filename convention:

- Use `v<version>.short-kebab-title.md` when a package or release version is available.
- Use `<yyyy-mm-dd>.short-kebab-title.md` only for repos without versioned releases.
- Keep names lowercase, stable, and specific.

## Public Guardrails

These notes are public and client-facing. Write for merchants, buyers, external developers, and operators who only see our products from the outside.

- Lead with customer-visible value and behavior changes.
- Translate implementation details into merchant, buyer, developer, or operator impact.
- Call out breaking changes, removed public APIs, migration work, or required operational action directly.
- Do not include War Room details, internal Campaign Map status names, local file paths, CI output, validation commands, raw stack traces, Sentry IDs, secrets, customer PII, private endpoints, or private incident details.
- Do not expose internal implementation details: no database table or column names, no ORM/entity or migration names, no internal service or queue names, no internal class, file, or module paths, no feature-flag keys, no environment variable names.
- Only reference things external consumers can already see: public API endpoints (with method + path), documented request/response DTO fields, public SDK exports, public CLI commands, and documented configuration keys.
- Do not paste commit lists. Consolidate changes into a few meaningful bullets.
- Keep the tone factual, calm, and polished.

### Developer notes

The `### Developer notes` section is for external developers integrating with our public surfaces (SDK consumers, API integrators, CLI users). It must not describe how the change was implemented inside our systems.

Write developer notes about:

- Public endpoint additions, renames, or removals (use the full `METHOD /path`).
- Request and response DTO field changes (use the documented field name).
- Public SDK exports added, renamed, or removed.
- Required client-side migration steps to stay compatible.

Do not write developer notes about:

- Database tables, columns, indexes, or migration filenames.
- Internal services, queues, jobs, repositories, controllers, or middleware.
- File paths inside our repos.
- Internal feature flag keys or environment variables.

## Good SDK Example

```markdown
---
title: v1.2.3 - Wallet fallback cleanup
description: Unsupported wallet options are now hidden so buyers can continue with available payment methods.
publishedAt: "2026-05-12T09:00:00.000Z"
tags:
  - Breaking Change
  - SDK
  - Checkout
---

Checkout now hides PayPal and wallet options when the current browser cannot complete those payment flows. Buyers can continue with other available methods, including card checkout, without seeing an extra browser warning.

### What changed

- Unsupported PayPal, Apple Pay, and Google Pay options collapse automatically when they are unavailable.
- The checkout UI no longer renders the in-app browser warning component.

### Developer notes

- The `InAppBrowserNotice` React export has been removed. Applications importing it directly should remove that import before upgrading.
```

## Good Backend Example

```markdown
---
title: More accurate retryable payment declines
description: Recoverable processor responses are now classified as retryable declines instead of technical errors.
publishedAt: "2026-05-12T09:00:00.000Z"
tags:
  - Improvement
  - Payments
  - Checkout
---

Checkout reporting now distinguishes recoverable processor responses from true technical failures more accurately. This gives merchants clearer payment-attempt outcomes and reduces false operational noise for retryable declines.

### What changed

- Recoverable processor responses such as temporary processing issues are recorded as retryable payment declines.
- Technical error reporting remains reserved for integration, configuration, or state failures that require operational attention.

### Why it matters

Merchants and support teams get clearer checkout outcomes, while buyers can still retry payment when the processor response indicates the failure may be temporary.
```
