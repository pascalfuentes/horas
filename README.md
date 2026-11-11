# Horas

Free time tracking that talks to your AI. Timer, projects and reports on the
web, plus a built-in MCP server, so Claude (or any MCP client) can start
timers, log hours and answer "how much did I work this week?" for you.

```
Astro 7 (SSR)  ·  Cloudflare Workers  ·  D1  ·  Better Auth  ·  MCP (Streamable HTTP)
```

## What's included

| | |
|---|---|
| **Timer** | start, stop, continue an entry; one timer per person, synced across tabs and with the AI |
| **Manual entry** | day, start, end or typed duration (`1h30`, `1:30`, `90`); edit, duplicate and delete |
| **Projects** | per workspace, with client, color, hourly rate and archiving |
| **Billing** | workspace currency and default hourly rate; amount computed on every billable entry |
| **Reports** | summary (by project, client, tag or description) and detailed; filters by project, client, tag and billable; CSV |
| **Import & export** | full backup as JSON, entries as CSV; import a Horas backup, a Horas CSV or Clockify's Detailed report CSV, with a preview and duplicate detection |
| **MCP** | 13 tools at `/mcp`, authenticated by personal token |
| **REST API** | the same operations at `/api/v1/…` |
| **Accounts** | e-mail and password, Google, GitHub, 2FA, per-device sessions |
| **Workspaces** | a personal one per account, invitations and roles (`owner`, `admin`, `editor`, `viewer`) |
| **LGPD** | export your own data (with the hours) and delete the account |

The accounts, workspaces and permissions part comes from the
[astro-auth-template](docs/auth-foundation.md). That document explains the
security decisions and still applies here.

## Run locally

```bash
npm install
cp .dev.vars.example .dev.vars   # change the two secrets
npm run db:local
npm run dev
```

Open <http://localhost:4321>. Without a superadmin you land on `/setup`; use
the `SETUP_SECRET` from `.dev.vars`. After that the home page becomes the
landing page and anyone can create an account at `/signup`. Without
`RESEND_API_KEY`, e-mails (verification, invitation, password) are printed to
the terminal.

```bash
npm run smoke   # end-to-end authentication suite (with dev running)
```

## Connect an AI

In the dashboard, **API & MCP → Generate token**. The token is shown once;
the screen itself already shows the commands filled in.

```bash
claude mcp add --transport http horas https://YOUR-DOMAIN/mcp \
  --header "Authorization: Bearer hrs_…"
```

Clients that only accept a URL (Claude's custom connector, for example) use
`https://YOUR-DOMAIN/mcp/hrs_…`. The token goes in the URL, so treat it as a
password.

Tools: `get_status`, `list_entries`, `summary_report`, `list_projects`,
`list_tags`, `get_settings`, `start_timer`, `stop_timer`, `add_entry`,
`update_entry`, `delete_entry`, `create_project`, `update_project`. A `viewer`
in the workspace only gets the first six.

### REST API

```bash
curl https://YOUR-DOMAIN/api/v1/status -H "Authorization: Bearer hrs_…"
```

| Method | Route | |
|---|---|---|
| GET | `/status` | running timer, totals for today and for the week |
| POST | `/timer/start` · `/timer/stop` | optional body: `description`, `project`, `tags`, `billable`, `start`/`end` |
| GET · POST | `/entries` | filters: `from`, `to`, `project`, `project_id`, `client`, `tag`, `billable`, `q`, `limit` |
| GET · PATCH · DELETE | `/entries/:id` | |
| GET · POST | `/projects` | `?archived=1` includes archived ones |
| PATCH · DELETE | `/projects/:id` | |
| GET | `/summary` | same filters as `/entries`; returns totals, amount and groups by project, client, tag, day and description |
| GET | `/tags` | tags already used |
| GET · PATCH | `/settings` | the workspace's `currency` and `default_rate` |
| GET | `/export.csv` | same filters as `/entries` |
| GET | `/backup.json` | everything of yours in the workspace: settings, projects and entries |
| POST | `/import` | the body is the file itself (send `Content-Type: text/csv` or `application/json`); `?dry_run=1` previews, `?date_format=mdy\|dmy` settles ambiguous dates |

Dates: ISO-8601. Without an offset (`2026-11-11T09:00`), they are interpreted
in the token's time zone, the one of the browser that created it. `from`/`to`
accept `YYYY-MM-DD`.

## Deploy (GitHub + Cloudflare)

```bash
npm run new-project        # creates the D1 database and writes wrangler.local.jsonc (out of Git)
npm run db:remote

npm run cf -- secret put BETTER_AUTH_SECRET   # openssl rand -base64 32
npm run cf -- secret put BETTER_AUTH_URL      # the final public URL, exact
npm run cf -- secret put SETUP_SECRET         # delete after the 1st admin
npm run cf -- secret put RESEND_API_KEY       # without it nobody receives the verification e-mail
npm run cf -- secret put EMAIL_FROM

npm run deploy
```

Then open `/setup` once to create the superadmin (they are required to enable
2FA) and delete `SETUP_SECRET`.

**Before opening to the public**, three things stop being optional:

1. **Real e-mail** (Resend with a verified domain). Signup requires confirming
   the e-mail; without sending, nobody other than whoever reads the log can
   get in.
2. **Turnstile** on the signup and login screens: see the auth foundation
   document.
3. **Social login**: create the OAuth apps at Google and GitHub with the
   redirect `https://YOUR-DOMAIN/api/auth/callback/google` (or `/github`) and
   store `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` and
   `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET` as secrets. Each button only
   appears when the pair exists.

For automatic deploys on every push, connect the repository in **Workers & Pages →
Create → Import a repository** (Workers Builds), with `npm run build` as the
build and `npx wrangler deploy` as the deploy.

## Where things are

```
migrations/0006_horas.sql         tables time_project, time_entry, api_token
migrations/0007_faturamento.sql   project hourly rate and workspace settings
src/lib/horas.ts                  core: every time rule, tied to (workspace, person)
src/lib/horas-api.ts              JSON router, the same for web and token
src/lib/horas-import.ts           reads backup JSON and CSV files (Horas and Clockify) for import
src/lib/horas-mcp.ts              MCP tools
src/lib/api-tokens.ts             create, revoke and authenticate tokens (only the SHA-256 is stored)
src/pages/api/w/[slug]/horas/     web API (cookie session)
src/pages/api/v1/                 token API
src/pages/mcp/                    MCP server
src/pages/w/[slug]/               time · reports · projects · integrations
public/app/horas.js               interface, no build and no dependencies
src/pages/index.astro             landing page
```

Decisions worth knowing:

- **Every entry belongs to one person in one workspace.** The core store is
  created with both ids and every query filters by both; there is no function
  that accepts another owner as a parameter. Projects belong to the workspace,
  shared.
- **The token carries no role.** It points to (person, workspace) and the role
  is read from `member` on every request, so demoting or removing someone
  takes effect immediately.
- **One timer per person per workspace**, guaranteed by a partial unique index
  in the database, not only in the application.
- **The amount of an entry is not stored.** It is hours × the project's rate
  (or the workspace default) computed on read; changing a rate recalculates
  what was already logged.
- **Stateless MCP.** Each request builds the server and answers in JSON; there
  is no session to keep, which is what a Worker wants.

## What's not there yet

- OAuth for MCP (today it is a personal token). Worth doing if the idea is to
  show up in connector directories.
- Team report: each person sees only their own hours, even the owner.
- Weekly timesheet, calendar and tasks inside projects.
- Currency conversion: the workspace currency is formatting only.
- The template's "Notes" example module is still in the code (the permission
  test suite depends on it); it was only removed from the menu.
