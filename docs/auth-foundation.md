# astro-auth-template

Application template with the authentication area ready. You clone it, run one
command, and start writing your application **inside** a system that already
has login, invitations, roles, sessions and audit working.

**Multi-tenant by workspace**: anyone creates an account, gets their own
workspace, and invites whoever they want into it. Who can do what is decided
by the role **inside each workspace**, not by a global role.

```
Astro 7 (SSR)  ·  Cloudflare Workers  ·  D1 + Drizzle  ·  Better Auth  ·  Resend
```

## What comes ready

| | |
|---|---|
| **Open signup** | with mandatory e-mail verification, Turnstile and rate limit |
| **Sign in** | e-mail + password, with optional Turnstile and rate limit |
| **Personal workspace** | created together with the account; whoever signs up becomes its `owner` |
| **Invite** | per workspace, with the role defined in the invitation; the recipient is notified in the dashboard |
| **Members** | change role, remove, leave, transfer ownership |
| **Recover password** | link by e-mail, single use, kills all sessions |
| **Profile** | name and phone |
| **Change password** | requires the current password, ends the other sessions |
| **Change e-mail** | the approval link goes to the **current** address |
| **Sessions** | list active devices and end them individually |
| **2FA** | TOTP + recovery codes, mandatory for admin |
| **Social login** | Google and GitHub; the account is created with the e-mail already verified |
| **Roles** | per workspace: `owner`, `admin`, `editor`, `viewer` |
| **Superadmin** | separate platform role, only for whoever operates the installation |
| **Audit** | who did what, to whom, when, from which IP |
| **Unlock 2FA** | admin restores access for someone who lost the phone and the codes |
| **LGPD** | download your own data and delete the account, with a privacy policy |

## Try it in two minutes

No Cloudflare account, nothing to configure:

```bash
npm install
cp .dev.vars.example .dev.vars
npm run db:local
npm run dev
```

Open <http://localhost:4321>. Without a superadmin you land on `/setup`; use
the `SETUP_SECRET` from `.dev.vars` and create the account that will operate
the installation. After that you can create regular accounts at `/signup`.
E-mails (verification, invitation, password recovery) are printed to the
terminal instead of being sent, which is enough to go through every flow.

```bash
npm run smoke   # 135 end-to-end checks
```

## Start a new project

On GitHub, click **Use this template → Create a new repository**. Then:

```bash
git clone <your-new-repository> && cd <it>
npm install
npm run new-project
```

`new-project` asks for the application name, creates the D1 database and
writes everything to **`wrangler.local.jsonc`**, a file out of Git with the
real ids of this deploy. The versioned `wrangler.jsonc` keeps its
placeholders, so that the next clone also starts clean.

Then it prints what is left: migrations, secrets and deploy.

> **Why two config files.** A template that carries a real `database_id` is a
> trap: you clone it for a client, run `npm run db:remote` before changing the
> id, and apply migrations to the production database of *another* project.
> The command would not complain: the id is valid and the database exists.
> Here the clone starts with a placeholder, `db:remote` refuses while it is
> there, and `db:local` works normally so you can develop from the first
> minute.

### Production

```bash
npm run db:remote

npm run cf -- secret put BETTER_AUTH_SECRET   # openssl rand -base64 32
npm run cf -- secret put BETTER_AUTH_URL      # the final public URL
npm run cf -- secret put SETUP_SECRET         # delete after the 1st admin
npm run cf -- secret put RESEND_API_KEY
npm run cf -- secret put EMAIL_FROM

npm run deploy
```

`BETTER_AUTH_URL` must be **exactly** the public URL. If it does not match the
domain being served, session cookies and the origin check fail and nobody gets
in.

After creating the first admin at `/setup`, delete the secret:

```bash
npm run cf -- secret delete SETUP_SECRET
```

### E-mail

Without `RESEND_API_KEY`, e-mails go to the Worker log (`npm run cf -- tail`)
instead of being sent. You can validate the whole flow this way, but it is not
suitable for real use: password recovery depends on e-mail arriving.

To really send you need a verified domain at
[Resend](https://resend.com): DKIM, two SPF CNAMEs and, preferably, DMARC. If
the domain is on Cloudflare, that is four records in DNS only (gray cloud;
when proxied, verification never passes).

### Social login (optional)

Create an OAuth app at the provider and point the *redirect URI* to
`https://YOUR-DOMAIN/api/auth/callback/google` (or `/github`). Then:

```bash
npm run cf -- secret put GOOGLE_CLIENT_ID
npm run cf -- secret put GOOGLE_CLIENT_SECRET
```

The same for `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`. Each provider only
appears when the **pair** of keys exists; configuring half turns nothing on.

For local development, the same four variables go in `.dev.vars`, with the
redirect pointing to `http://localhost:4321/api/auth/callback/google`.

### Turnstile (anti-bot protection)

```bash
npm run cf -- turnstile widget create "my-app" --domain my-domain.com --mode managed
```

The `sitekey` is public and goes in `vars` in `wrangler.local.jsonc`; the
secret key goes in `npm run cf -- secret put TURNSTILE_SECRET_KEY`.

The widget is only rendered when **both** keys exist. This is deliberate: with
only the sitekey, the person would solve the challenge and the server would
check nothing. Fake protection is worse than none, because it looks like it is
there.

**To turn it off in an emergency**, if Turnstile blocks someone's login:

```bash
npm run cf -- secret delete TURNSTILE_SECRET_KEY
```

The widget disappears and the verification is skipped, on both sides at the
same time. The rate limit stays in place.

## Putting your application inside

The **Notes** module exists for this: it is the reference example of a
business area protected by the permission matrix. Copy its pattern.

There are six touch points:

| # | File | What to do |
|---|---|---|
| 1 | `migrations/000N_….sql` | create the table (a new migration, never editing the old ones) |
| 2 | `src/db/schema.ts` | mirror the table in Drizzle |
| 3 | `src/lib/permissions.ts` | reuse `content:read`/`content:write` or create your own permission |
| 4 | `src/pages/dashboard/….astro` | the page (reads from the database, uses `can()` only to hide what would fail) |
| 5 | `src/pages/api/….ts` | the write endpoint, starting with `deny(locals, PERMISSIONS.X)` |
| 6 | `src/layouts/Dashboard.astro` | the link in the side navigation |

The rule that cannot be broken is the one in item 5: **every route that writes
starts with `deny()`**. Hiding the button in the interface is not
authorization; it is just a courtesy to someone who would not have succeeded
anyway.

It is worth adding the corresponding check to `scripts/smoke.sh`, in the
authorization block. It is one line, and it is what prevents the permission
from silently ceasing to apply in a future refactor.

### Removing the example module

When your real application is in place:

- `src/pages/dashboard/notes.astro` and `src/pages/api/notes.ts`: delete
- `migrations/0000_init.sql`: the `note` table (or a new migration with `DROP TABLE`)
- `src/db/schema.ts`: `note` and its entry in `schema`
- `src/layouts/Dashboard.astro`: the "Notes" link
- `src/lib/http.ts`: the `ok_note` message
- `scripts/smoke.sh`: the checks that use `/api/notes`

## How it is organized

```
wrangler.jsonc         TEMPLATE config (placeholders, goes to Git)
wrangler.local.jsonc   THIS deploy's config (real ids, out of Git)

migrations/
  0000_init.sql        tables (Better Auth + invitation, audit, example)
  0001_invariants.sql  TRIGGERS for "there must always be an admin"
src/
  config.ts            application name and invitation validity
  middleware.ts        resolves the session and does the coarse route gating
  db/schema.ts         Drizzle mirror of the migrations
  lib/
    auth.ts            Better Auth + plugins + callAuth()
    workspaces.ts      create workspace, membership, slug
    platform.ts        queries about the installation (superadmins, users)
    permissions.ts     role × permission matrix
    guards.ts          deny() for API handlers
    audit.ts           audit trail
    errors.ts          unwraps D1 errors (LAST_ADMIN, UNIQUE)
  pages/
    login · signup · verify-email · two-factor
    forgot-password · reset-password · setup · privacy · 404 · 500
    dashboard/         profile · security · security/2fa (account)
    w/[slug]/          home · notes (example) · members · settings
    invite/[id]        acceptance, public: people without an account need to reach it
    workspaces         list and create
    dashboard/admin/   users · audit (superadmin only)
    api/               form endpoints (work without JavaScript)
scripts/
  new-project.mjs      clone → new project
  config.mjs           resolves which wrangler.jsonc applies
  d1.mjs               migrations, with the production guard
  totp.mjs             generates a TOTP code (used by the suite; useful for debugging)
  cf.mjs               wrangler pointing at the right config
  smoke.sh             end-to-end suite
```

The migrations are **written by hand**: `drizzle-kit` does not generate the
invariant triggers. `src/db/schema.ts` is the typed mirror; when you change
one, change the other.

## Decisions worth understanding

### The invitation belongs to the e-mail that received it, and to nobody else

Two guards, both from the plugin, and both necessary:

1. The **session's** e-mail must be the invitation's. Without this, anyone who
   intercepted the link would join someone else's workspace with their own
   account.
2. The e-mail must be **verified**. Without this, it would be enough to sign up
   with an invitee's address to inherit their invitation, and signup is open.

The `/invite/[id]` page is public, because someone who does not have an
account yet needs to reach it and understand what to create. What it shows
(workspace name and invited e-mail) is what whoever has the link already
received by e-mail. The **acceptance** is what has the guards.

Nobody is invited as `owner`: you become an owner by transfer, which is a
deliberate action by someone who already is an owner.

### The invitation also appears inside the dashboard

The e-mail link cannot be the only path. E-mail gets lost, lands in spam, or
is deleted by accident, and then the person is stuck even while already signed
in, because nothing in the interface indicates that there is an invitation
waiting for them.

So the dashboard tells them: a notice at the top of every page, with the
workspace name, the role offered, who invited, and the accept and decline
buttons. The full list lives at `/workspaces`, and the top notice is omitted
there to avoid duplication.

What does **not** change is who authorizes. The buttons post to the same
`/api/invite/accept` as the public page, and the two guards remain the
plugin's. The notice decides what appears on screen; it decides nothing about
access.

The query matches by **e-mail**, which is the same key the plugin checks on
acceptance, not by `userId`, which the invitation does not even know. And it
has a cap of 20: creating workspaces is free, so without a limit someone could
open dozens and invite the same person from each one just to clutter their
screen.

### Transferring ownership promotes before demoting

The order is not cosmetic. Promoting the new person first leaves the workspace
with two owners for an instant; demoting first would leave zero, and the
`keep_one_owner_on_update` trigger would abort. Correctly so, because the
workspace would be left without an owner midway.

Whoever transfers becomes `admin`: they keep working and lose only what is
exclusive to the owner. And the last owner **cannot leave** the workspace; the
trigger guarantees this, not the application.

### The workspace lives in the URL, not in the session

The plugin stores the active organization in `session.activeOrganizationId`:
**a single value per session**. With two tabs open on different workspaces,
the second one changes the first one's active workspace, and the first keeps
looking correct on screen while acting on the wrong workspace. In a product
where each workspace is a client's site, that is destructive, not cosmetic.

That is why the URL is the source of truth: `/w/[slug]/…` and
`/api/w/[slug]/…`. The middleware reads the slug, checks the membership and
fills `locals.membership`. Every write uses the workspace resolved from there,
never a `workspaceId` coming from the form, which would let anyone write to
any workspace.

`activeOrganizationId` still exists, with a single role: remembering the last
workspace used, so `/dashboard` knows where to send the person.

A workspace you are not a member of answers **404, not 403**. "No permission"
would confirm that the slug exists, which is free information for anyone
probing.

### Roles inside the workspace

| | `owner` | `admin` | `editor` | `viewer` |
|---|:-:|:-:|:-:|:-:|
| Read content | ✓ | ✓ | ✓ | ✓ |
| Write content | ✓ | ✓ | ✓ | — |
| See members | ✓ | ✓ | ✓ | ✓ |
| Invite and manage members | ✓ | ✓ | — | — |
| Workspace settings | ✓ | ✓ | — | — |
| Delete the workspace | ✓ | — | — | — |
| Transfer ownership | ✓ | — | — | — |

Notice what is **not** in the table: changing your own account. The account
exists outside any workspace: the same person can be `owner` in one and
`viewer` in another, and there is only one password. Guarding that by
workspace role would mix two different questions, so a separate guard
(`denyAccount`) takes care of it. Someone who is only a `viewer` can still
change their own password and their own 2FA.

There are three guards because there are three questions: `denyAccount` (is it
you?), `deny` (can you do this in this workspace?) and `denyPlatform` (do you
operate the installation?).

### Two levels of role, and only one of them decides the day to day

`user.role` (platform) answers a single question: **who operates the
installation**. It decides nothing inside any workspace. Values: `admin` and
`user`.

`member.role` (workspace) is what decides reading and writing: `owner`,
`admin`, `editor`, `viewer`. It is per workspace, so the same person can be
`owner` in one and `viewer` in another.

The superadmin does **not** get a free pass into someone else's workspace: to
act in a workspace, they need to be a member of it. Fail-closed.

### Open signup requires e-mail verification

While access was by invitation, receiving the invitation already proved
ownership of the address. With open signup that goes away, and
`requireEmailVerification: true` becomes what prevents someone from creating
an account with another person's e-mail.

Signup also **does not reveal whether an e-mail already has an account**: it
answers the same thing in both cases, and when the account exists it notifies
the owner by e-mail instead of telling whoever tried. It is the same principle
that login and password recovery already followed.

### Every workspace has at least one owner, guaranteed in the database

Same reasoning as the last admin, now per workspace, and with one more trap.
The trigger needs `EXISTS (SELECT 1 FROM organization ...)` in the `WHEN`
clause: without it, the trigger fires during the CASCADE of deleting the
workspace and makes deletion **impossible**. Verified empirically, and the
suite has a test just to prevent this regression.

Practical consequence when deleting an account: if the person is the only
owner, the workspace must be deleted BEFORE the user. In the reverse order the
database refuses. When the workspace has other members, deleting the account
is blocked, because it would take everyone's work along.

A second trigger guarantees that `member.role` is **exactly one** of the four
roles: Better Auth accepts comma-separated roles and resolves permissions with
`split(",")`, which would open a hole in the owner trigger, which compares
with `=`.

### "There must always be an admin" lives in the database

Checking in JavaScript does not solve it: two simultaneous requests read
"there are 2 admins", both pass, and you end up with zero. The invariant is in
`migrations/0001_invariants.sql`, as `TRIGGER ... RAISE(ABORT, 'LAST_ADMIN')`
on the `UPDATE` of `role`/`banned` and on `DELETE`. Not even a manual `UPDATE`
in D1 can demote the last active administrator.

The application still blocks the obvious cases (nobody changes their own role,
nobody disables their own account) and translates `LAST_ADMIN` into a readable
message, but the guarantee is the database's.

### Credential routes go through the HTTP handler

`callAuth()` builds a `Request` and calls `auth.handler()` instead of
`auth.api.signInEmail()`. The difference is the **rate limiter**, which lives
in the router layer: calling `auth.api.*` directly, six wrong password
attempts went through without ever hitting the 5/minute limit. The already
authenticated routes (admin, profile) stay on `auth.api.*`, where the session
is the barrier.

### No account enumeration

Wrong password and nonexistent e-mail return the same message.
`/forgot-password` always answers "if an account exists, we sent the link",
even when sending fails. Error messages are **codes** in the query string
(`?e=credentials`), never text coming from the user.

### Deleting an account preserves the audit trail, but dissociates it

The privacy policy promises the two LGPD rights that matter here: downloading
your own data and deleting the account. Both routes exist, and the choices
they make are written on the page itself.

The export leaves out the password hash, the 2FA secret, the recovery codes
and the social provider tokens. They are access credentials, not information
about the person; handing them over in a file only creates a new way to leak
the account.

On deletion, the audit trail does **not** go along: it exists for the security
of everyone in the system, and deleting it would open a hole exactly where it
would matter most. What happens is dissociation: e-mails become
`[conta removida]`, ids become null, and the IP disappears when it belonged to
the deleted person. When the IP belongs to whoever *performed* the action (an
admin revoking sessions, for example), it stays, because that person remains
identifiable and accountable.

The last-admin trigger still applies: the only active administrator account
cannot delete itself.

### 2FA that locks nobody out

Two choices make the difference between protection and a headache.

**Enabling does not turn 2FA on.** `/two-factor/enable` generates the secret,
but `twoFactorEnabled` only becomes true when the person confirms the first
code. Someone who scanned the QR wrong, ran out of battery or closed the tab
halfway simply keeps signing in with the password.

**Mandatory for admin, but as a navigation block.** With
`REQUIRE_2FA_FOR_ADMINS` (in `src/config.ts`, on by default), an admin without
2FA signs in normally and is taken to the setup screen, where they stay until
they enable it. Nobody loses access, and the account that invites people and
changes roles does not go unprotected, because whoever gets into it can invite
themselves back as many times as they want.

The secret and the recovery codes appear **only once**, in Better Auth's
response. That is why the setup page responds to its own POST instead of
redirecting: redirecting would lose them, and passing them through the query
string would put a secret in the browser history and in the server logs.

The administration panel has **Unlock**, which removes the second factor from
someone who lost the phone *and* the recovery codes. Without it, the person
would be locked out forever and not even an admin could help, except by
editing the database by hand. The action revokes their sessions and is
recorded in the audit trail.

Recovery codes are valid once each, and five wrong codes in a row lock the
account for 15 minutes: six digits are only a million possibilities, which is
not much for someone who can try at will.

## What is NOT here

Left out on purpose, for you to add when you need it:

- **SSO / OIDC**: if one day this becomes a central service instead of a
  per-project template, the `oidcProvider` plugin is the way, without
  rewriting the rest.
- **Unit tests**: `scripts/smoke.sh` covers the full path, but it does not
  replace unit tests.

## Commands

| | |
|---|---|
| `npm run new-project` | turns a clone into a new project |
| `npm run dev` | local server with D1 and real workerd secrets |
| `npm run smoke` | suite of 135 end-to-end checks |
| `npm run check` | typecheck (`astro check`) |
| `npm run build` | production build |
| `npm run deploy` | build + deploy |
| `npm run db:local` | migrations on the local D1 |
| `npm run db:remote` | migrations in production (refuses if the id is the template's) |
| `npm run db:sql -- "SELECT …"` | quick query on the local database |
| `node scripts/totp.mjs <secret>` | generates the TOTP code for a secret |
| `npm run cf -- <args>` | `wrangler` pointing at the right config |

CI (`.github/workflows/ci.yml`) runs typecheck, build and the full suite on
every push. All local: it needs no Cloudflare credential and does not touch
production.

## License

MIT. See [LICENSE](LICENSE).
