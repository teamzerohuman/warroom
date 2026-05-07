# Pinned Codex Plugins

War Room vendors Codex plugins here so handoffs can reference stable repo-local plugin assets instead of user-level cache paths.

Pinned sources:

- `github`: copied from `openai-curated/github/cc8b2295`
- `coderabbit`: copied from `openai-curated/coderabbit/cc8b2295`
- `cloudflare`: copied from `openai-curated/cloudflare/cc8b2295`
- `railway`: local War Room plugin that points to Railway's remote MCP endpoint

The repo-local marketplace is `.agents/plugins/marketplace.json`. Keep its `name` as `openai-curated` so existing plugin URLs such as `plugin://github@openai-curated`, `plugin://coderabbit@openai-curated`, `plugin://cloudflare@openai-curated`, and `plugin://railway@openai-curated` resolve against these pinned local copies when the repo marketplace is loaded.

Remote MCP auth:

- Cloudflare exposes `cloudflare-api` at `https://mcp.cloudflare.com/mcp` and reads `CLOUDFLARE_API_TOKEN` when bearer-token auth is available. OAuth can also be refreshed with `codex mcp login cloudflare-api`.
- Railway exposes `railway` at `https://mcp.railway.com` and reads `RAILWAY_TOKEN` when bearer-token auth is available. OAuth can also be refreshed with `codex mcp login railway`.
- Put real tokens only in `.env.local` or your shell environment. War Room passes `.env.local` values to local adapter launches, but `.env.local` remains ignored and must never be committed.
