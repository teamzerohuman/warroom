# LLM Operations

War Room launches LLM adapters only when a command is explicitly given `--launch`, except interactive `issue next`, where selecting an issue launches the configured adapter by default, and interactive `pr review`, where confirming a detected PR launches the review loop. Without launch behavior, issue and PR commands print scoped prompts and can write local artifacts under `.warroom/runs/*`; for `issue next`, use `--dry-run` for that preview path.

Interactive `issue next` and direct `issue next --issue owner/repo#number` are implementation launches. Before launching, War Room creates a GitHub-linked development branch with `gh issue develop` so the issue, branch, and eventual PR stay connected in GitHub. Foreground/local adapters require a clean checkout because War Room checks out that branch locally before launch. Codex Cloud task adapters create the linked branch without local checkout, so unrelated local dirty files do not block the cloud task. The adapter is instructed to use that branch, fetching and switching to it first if the remote/cloud checkout starts on another branch. It uses the complete GitHub issue body and discussion as already-triaged context, edits the owning child repo, runs relevant validation, commits when validation passes, and includes `Closes <issue>` in the PR body. It must not stop at a preflight or create standalone planning markdown unless the issue specifically asks for product documentation.

`pr create` is the publication step after implementation work is committed. It runs from the mapped child repo, uses the current or supplied branch, infers the linked issue from `warroom/<issue-number>-...` when possible, generates a PR title/body from issue and commit context unless supplied explicitly, and creates the GitHub PR only with `--confirm`.

`pr review` uses a fixed GitHub/CodeRabbit handoff. Launched runs wait for a new PR commit after each adapter pass, check current unresolved CodeRabbit comments, and relaunch the adapter while CodeRabbit feedback remains. This command always uses the foreground adapter, even when `LLM_ADAPTER=codex-cloud`, because Codex Cloud environments do not inherit local GitHub/CodeRabbit app access, `gh` auth, or local PR remotes.

## Configuration

`.env.local.example` documents safe placeholders:

```sh
LLM_ADAPTER=codex
CODEX_COMMAND=codex
CLAUDE_COMMAND=claude
CODEX_CLOUD_ENV=
CODEX_CLOUD_ENV_BACKEND=
CODEX_CLOUD_ENV_SDK=
```

For Codex, `CODEX_COMMAND` is the executable path only. If `codex` is not on `PATH`, set it to the bundled Codex Desktop executable, for example `/Applications/Codex.app/Contents/Resources/codex` on macOS. War Room launches development handoffs with `codex exec --cd <owning-repo> -` so edits happen from the mapped child repository instead of the War Room workspace.

For durable background work, set `LLM_ADAPTER=codex-cloud` and a repo-specific environment id such as `CODEX_CLOUD_ENV_BACKEND=<environment-id>` or `CODEX_CLOUD_ENV_SDK=<environment-id>`. War Room picks the environment from the owning repo id in `repos.yaml`, submits with `codex cloud exec --env <environment-id> <prompt>`, and exits after the cloud task is created. `CODEX_CLOUD_ENV` is only a fallback for commands that are not tied to a mapped repo.

The environment id is the Codex Cloud target environment id, not a War Room value. The bundled CLI describes it as `ENV_ID` in `codex cloud exec --help` and says `codex cloud` browses configured environments. If `codex cloud` opens Codex Desktop but does not show an environment id, finish Codex Cloud environment setup for the target repo first; War Room cannot submit a durable task until that id exists.

Real provider keys and local secrets belong in `.env.local`, ally-specific `.env.local` files, the developer's configured MCP/tool environment, or an approved secret manager. They are never committed.

## Handoff Rules

- Include the selected issue or PR, relevant metadata, repo ownership, and validation requirements.
- Include only scoped context; do not dump whole repos by default.
- Preserve child repo boundaries and read child `AGENTS.md` before product edits.
- Pause when context is too large, feedback is circular, or the owner repo is ambiguous.

## Dry Run Examples

```sh
npm run warroom -- issue triage --issue TeamFloPay/infra#4 --write-artifact
npm run warroom -- issue next --issue TeamFloPay/infra#4 --dry-run --write-artifact
npm run warroom -- pr create --write-artifact
npm run warroom -- pr review --pr TeamFloPay/warroom#1 --write-artifact
npm run warroom -- pr merge --pr TeamFloPay/warroom#1 --issue TeamFloPay/infra#4 --write-artifact
```

Artifacts are local audit/debug files. GitHub comments should contain useful summaries, not local artifact paths.
