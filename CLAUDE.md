# CLAUDE.md

**openmail** — agent-first email: one multi-tenant Cloudflare Worker that sends transactional mail and
gated campaigns, with an HTTP API for apps and an MCP server for agents. Agents draft; only a signed-in
owner can approve a send.

## This repo is PUBLIC
- Never commit secrets, `.dev.vars`, `.infisical.json`, tenant names, subscriber data or internal URLs.
- Secrets live in Infisical only and reach Workers as Worker secrets. Run anything that needs them with
  `infisical run --env=dev -- <cmd>`.

## Rules (mirrored from the projects that use this service)
- **Branch hygiene:** the home-base clone stays on `main`. Every task gets a worktree off `origin/main`:
  `git worktree add -b <branch> ../openmail-<task> origin/main`. `scripts/check-worktree-isolation.sh`
  enforces this at commit time.
- **One change per PR**, one PR per build step.
- **TDD:** write the failing test first, see it fail for the right reason, then make it pass.
- **Schema changes only through Drizzle:** edit `src/db/schema.ts`, run `npm run db:generate`. Never
  hand-edit `drizzle/*.sql` or `drizzle/meta/*`, and never run manual DDL against D1.
- **Deploys only through GitHub Actions** on merge to `main` (`.github/workflows/deploy.yml`).
  Never run `wrangler deploy` by hand.
- **Run `npm run preflight` before pushing.** It runs the same gates as CI; add any new CI gate to
  `scripts/preflight.sh` in the same commit.

## Environments
- **Local** (`npm test`, `npm run dev`): the inner loop. Real Workers runtime, local D1, queues and
  Durable Objects; nothing leaves the machine.
- **Previews** (Cloudflare Worker Previews): every pull request gets one from `.github/workflows/preview.yml`.
  Bound to preview-only D1 (`openmail-preview`), KV and queue, with no SES credentials; queue consumers
  and cron don't run there, so a Preview can never send email. Links use the Preview's own address
  (`OPENMAIL_PREVIEW=1`). Preview secrets (`BETTER_AUTH_SECRET`, `ADMIN_API_TOKEN`) are separate from
  production's and set in the Preview base config.
- **Production** (`mail.mattwalker.co`): deployed only from `main`. Real sends are first tested here
  with a seed list before any real audience moves over.

## Commands
| Want to… | Run |
|---|---|
| Tests (local D1 in the Workers runtime) | `npm test` |
| Type-check | `npm run type-check` |
| All CI gates | `npm run preflight` |
| Generate a migration | `npm run db:generate` |
