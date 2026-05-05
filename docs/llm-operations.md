# LLM Operations

War Room launches LLM adapters only when a command is explicitly given `--launch`, except interactive `issue next`, where selecting an issue launches the configured adapter by default. Without launch behavior, issue and PR commands print scoped prompts and can write local artifacts under `.warroom/runs/*`; for `issue next`, use `--dry-run` for that preview path.

`pr engage` and interactive `issue next` are implementation launches. They instruct the adapter to create or switch to a feature branch, use the GitHub issue body and discussion as already-triaged context, edit the owning child repo, run relevant validation, and commit when validation passes. They must not stop at a preflight or create standalone planning markdown unless the issue specifically asks for product documentation.

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
npm run warroom -- pr engage --issue TeamFloPay/infra#4 --write-artifact
npm run warroom -- pr review --pr TeamFloPay/warroom#1 --write-artifact
npm run warroom -- pr merge --pr TeamFloPay/warroom#1 --issue TeamFloPay/infra#4 --write-artifact
```

Artifacts are local audit/debug files. GitHub comments should contain useful summaries, not local artifact paths.
