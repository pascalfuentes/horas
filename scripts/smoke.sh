#!/usr/bin/env bash
# Smoke suite: exercises the flows and the invariants against the development
# server. It does not replace unit tests; it proves that the full path
# (HTTP → Better Auth → D1 → triggers) is standing.
#
#   1. npm run dev          (in another terminal)
#   2. ./scripts/smoke.sh
#
# RECREATES the LOCAL database from scratch. Never point it at production.
set -uo pipefail

BASE="${BASE:-http://localhost:4321}"
# Database name and config path come from the same source as the rest of the
# scripts, otherwise the suite queries one database and the server uses another.
CFG="$(node -e "import('./scripts/config.mjs').then(m=>process.stdout.write(m.configPath()))")"
DB="${DB:-$(node -e "import('./scripts/config.mjs').then(m=>process.stdout.write(String(m.readConfig().databaseName)))")}"
TMP="$(mktemp -d)"
ADMIN="$TMP/admin.txt"
VIEWER="$TMP/viewer.txt"
PASS=0; FAIL=0

c() { printf '\033[%sm%s\033[0m' "$1" "$2"; }
check() { # check <description> <expected> <obtained>
  if [[ "$3" == *"$2"* ]]; then
    printf "  %s %s\n" "$(c 32 '✓')" "$1"; PASS=$((PASS+1))
  else
    printf "  %s %s\n      expected to contain: %s\n      got:                 %s\n" "$(c 31 '✗')" "$1" "$2" "${3:-<empty>}"; FAIL=$((FAIL+1))
  fi
}
post() { # post <jar|-> <path> <field=value...>
  local jar="$1" path="$2"; shift 2
  local args=(-s -o /dev/null -w '%{http_code} %{redirect_url}' -X POST "$BASE$path" -H "Origin: $BASE")
  [[ "$jar" != "-" ]] && args+=(-b "$jar" -c "$jar")
  local f; for f in "$@"; do args+=(--data-urlencode "$f"); done
  curl "${args[@]}"
}
get() { curl -s -o /dev/null -w '%{http_code} %{redirect_url}' ${2:+-b "$2"} "$BASE$1"; }
has() { # has <path> <jar> <text>: "yes" if the page contains the text, "no" otherwise
  # The whole page is read before answering: a grep that stops at the first
  # match closes the pipe on curl, and with pipefail that reads as "not found"
  # whenever the text comes early in a page that is still arriving.
  if curl -s -b "$2" "$BASE$1" | grep -cF "$3" >/dev/null; then echo yes; else echo no; fi
}
found() { # found <text> <html>: "yes" if the text is in a page already fetched, "no" otherwise
  if [[ "$2" == *"$1"* ]]; then echo yes; else echo no; fi
}
found_re() { # found_re <regex> <html>: the same, for an extended regular expression
  if grep -qE -- "$1" <<<"$2"; then echo yes; else echo no; fi
}
sql() { npx wrangler d1 execute "$DB" --local -c "$CFG" --json --command "$1" 2>/dev/null \
        | python3 -c 'import sys,json;print(json.dumps(json.load(sys.stdin)[0]["results"]))'; }
sql_err() { npx wrangler d1 execute "$DB" --local -c "$CFG" --command "$1" 2>&1 | sed $'s/\033\\[[0-9;]*m//g'; }
# Enables 2FA for an account: starts the setup, extracts the TOTP secret and
# the recovery codes from the page, and confirms with a real code.
# Fills SECRET_2FA and CODES_2FA.
enable_2fa() { # enable_2fa <jar> <password>
  local jar="$1" password="$2"
  HTML_2FA="$(curl -s -b "$jar" -c "$jar" -X POST "$BASE/dashboard/security/2fa" \
              -H "Origin: $BASE" --data-urlencode "password=$password")"
  local html="$HTML_2FA"
  SECRET_2FA="$(printf '%s' "$html" | grep -oE '<code>[A-Z2-7]{16,}</code>' | head -1 | sed 's/<[^>]*>//g')"
  CODES_2FA="$(printf '%s' "$html" | python3 -c "
import re, sys
m = re.search(r'<pre[^>]*>(.*?)</pre>', sys.stdin.read(), re.S)
print('\n'.join(l.strip() for l in m.group(1).split('\n') if l.strip()) if m else '')")"
  [[ -z "$SECRET_2FA" ]] && return 1
  post "$jar" /api/security/2fa action=confirm "code=$(node scripts/totp.mjs "$SECRET_2FA")" >/dev/null
}
totp_code() { node scripts/totp.mjs "$SECRET_2FA"; }
reset_rate_limit() { npx wrangler d1 execute "$DB" --local -c "$CFG" --command 'DELETE FROM "rateLimit";' >/dev/null 2>&1; }
# Creates an account through open signup and leaves it ready to sign in.
#
# `emailVerified` is turned on in SQL on purpose: the verification token is a
# signed JWT, not a row in the database, so there is no deterministic way to
# read it from here. The GATE (login blocked before verifying) is tested
# separately, and that is the security property that matters.
create_account() { # create_account <jar|-> <name> <email> <password>
  post - /api/signup "name=$2" "email=$3" "password=$4" "confirm=$4" >/dev/null
  sql "UPDATE user SET emailVerified = 1 WHERE email = '$3'" >/dev/null
  reset_rate_limit
  [[ "$1" != "-" ]] && post "$1" /api/login "email=$3" "password=$4" >/dev/null
  return 0
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then printf '%s' "$1" | sha256sum | cut -d' ' -f1
  else printf '%s' "$1" | shasum -a 256 | cut -d' ' -f1; fi
}
invite_id() { # invite_id <email>: the most recent pending invitation for that e-mail
  sql "SELECT id FROM org_invitation WHERE email='$1' AND status='pending' ORDER BY createdAt DESC LIMIT 1" \
    | python3 -c 'import sys,json;r=json.load(sys.stdin);print(r[0]["id"] if r else "")'
}
member_id() { # member_id <email> <slug>
  sql "SELECT m.id FROM member m JOIN user u ON u.id=m.userId JOIN organization o ON o.id=m.organizationId WHERE u.email='$1' AND o.slug='$2'" \
    | python3 -c 'import sys,json;r=json.load(sys.stdin);print(r[0]["id"] if r else "")'
}
role_of() { # role_of <email> <slug>
  sql "SELECT m.role FROM member m JOIN user u ON u.id=m.userId JOIN organization o ON o.id=m.organizationId WHERE u.email='$1' AND o.slug='$2'"
}
slug_of() { # slug_of <email>: the person's personal workspace
  sql "SELECT o.slug FROM organization o JOIN member m ON m.organizationId=o.id JOIN user u ON u.id=m.userId WHERE u.email='$1' LIMIT 1" \
    | python3 -c 'import sys,json;r=json.load(sys.stdin);print(r[0]["slug"] if r else "")'
}
set_ws_role() { # set_ws_role <email> <slug> <role>
  sql "UPDATE member SET role='$3' WHERE userId=(SELECT id FROM user WHERE email='$1') AND organizationId=(SELECT id FROM organization WHERE slug='$2')" >/dev/null
}
id_of() { sql "SELECT id FROM user WHERE email='$1'" | python3 -c 'import sys,json;r=json.load(sys.stdin);print(r[0]["id"] if r else "")'; }
# The sums the database keeps for the project list (`time_project_total`,
# migration 0013) against what the entries add up to at this moment, in the
# same unit. `"missing": 0, "extra": 0` when the two agree; `kept` is how many
# rows of sums there are.
totals_state() {
  local ticks='COALESCE(CAST((julianday("end") - julianday("start")) * 2147483648.0 AS INTEGER), 0)'
  sql "WITH fresh AS (
         SELECT workspaceId, projectId, userId, COUNT(*), SUM(billable), SUM($ticks), SUM((billable = 1) * $ticks)
           FROM time_entry WHERE projectId IS NOT NULL GROUP BY 1, 2, 3)
       SELECT (SELECT COUNT(*) FROM (SELECT * FROM fresh EXCEPT SELECT * FROM time_project_total)) AS missing,
              (SELECT COUNT(*) FROM (SELECT * FROM time_project_total EXCEPT SELECT * FROM fresh)) AS extra,
              (SELECT COUNT(*) FROM time_project_total) AS kept"
}
# Deleting the D1 file does not work: the dev server keeps the old handle open
# and the two start seeing different databases. And the last-admin trigger
# blocks the DELETE. So we drop the triggers, clean up and recreate the
# triggers from the migration itself.
reset_db() {
  npx wrangler d1 execute "$DB" --local -c "$CFG" --command '
    DROP TRIGGER IF EXISTS keep_one_admin_on_update;
    DROP TRIGGER IF EXISTS keep_one_admin_on_delete;
    DROP TRIGGER IF EXISTS keep_one_owner_on_update;
    DROP TRIGGER IF EXISTS keep_one_owner_on_delete;
    DROP TRIGGER IF EXISTS member_papel_valido_insert;
    DROP TRIGGER IF EXISTS member_papel_valido_update;
    DROP TRIGGER IF EXISTS user_papel_plataforma_valido_insert;
    DROP TRIGGER IF EXISTS user_papel_plataforma_valido_update;
    DELETE FROM session; DELETE FROM account; DELETE FROM verification;
    DELETE FROM "rateLimit"; DELETE FROM audit_log; DELETE FROM note;
    DELETE FROM "twoFactor"; DELETE FROM org_invitation; DELETE FROM member;
    DELETE FROM organization; DELETE FROM user;' >/dev/null 2>&1
  npx wrangler d1 execute "$DB" --local -c "$CFG" --file migrations/0001_invariants.sql >/dev/null 2>&1
  npx wrangler d1 execute "$DB" --local -c "$CFG" --file migrations/0005_workspace_invariants.sql >/dev/null 2>&1
}

command -v python3 >/dev/null || { echo "python3 is required"; exit 1; }
SECRET="$(grep -E '^SETUP_SECRET=' .dev.vars 2>/dev/null | cut -d'"' -f2)"
[[ -z "${SECRET:-}" ]] && { echo "SETUP_SECRET not found in .dev.vars"; exit 1; }

# Without this, a server that is down becomes 40 red failures that say nothing.
STATUS="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/login" 2>/dev/null || echo 000)"
if [[ "$STATUS" != "200" ]]; then
  echo
  echo "$(c 31 '✗') The server did not respond at $BASE (HTTP ${STATUS})."
  echo
  echo "  Start it with \`npm run dev\` in another terminal and run again."
  echo "  If it was already running, restart it: \`npx astro dev stop && npm run dev\`"
  echo "  (running \`npm run build\` with the dev server up usually takes it down)."
  echo
  exit 1
fi

echo "Recreating the local database…"; reset_db

echo; echo "$(c 1 'First administrator bootstrap')"
check "/ goes to /setup with an empty database"        "/setup"           "$(get /)"
check "/dashboard without a session goes to /login"    "/login?next"      "$(get /dashboard)"
check "setup with the wrong secret is refused"         "e=no_permission"  "$(post - /api/setup secret=errado name=X email=x@y.com password=senha-longa-o-suficiente confirm=senha-longa-o-suficiente)"
check "setup with the right secret creates the admin"  "/dashboard"       "$(post "$ADMIN" /api/setup "secret=$SECRET" "name=Admin Teste" email=admin@exemplo.com password=senha-longa-o-suficiente confirm=senha-longa-o-suficiente)"
check "first user was created with role=admin"         '"role": "admin"'  "$(sql "SELECT role FROM user WHERE email='admin@exemplo.com'")"
check "/setup dies after the first user"               "/login"           "$(get /setup)"
check "the admin signs in and is sent to set up 2FA"    "/dashboard/security/2fa"  "$(get /dashboard "$ADMIN")"

echo; echo "$(c 1 'Two-step verification (required for admin)')"
enable_2fa "$ADMIN" senha-longa-o-suficiente
check "the setup returns a TOTP secret"                "ok"                        "${SECRET_2FA:+ok}"
check "and ten recovery codes"                         "10"                        "$(printf '%s\n' "$CODES_2FA" | grep -c .)"
# The QR generator emits the SVG with only a viewBox. In a `width: max-content`
# container that collapses to 0×0: the QR existed in the HTML and did not show
# on screen. Checking that an <svg> exists was not enough; what matters is that
# it has a size. (The sidebar icons are SVGs too, so they are skipped.)
check "the QR has an explicit size (not 0x0)"          'width="220"'               "$(printf '%s' "$HTML_2FA" | grep -oE '<svg[^>]*' | grep -vE 'nav-ico|class="logo"' | head -1)"
check "confirming turns 2FA on"                        '"twoFactorEnabled": 1'     "$(sql "SELECT twoFactorEnabled FROM user WHERE email='admin@exemplo.com'")"
check "admin can browse freely again"                  "200"                       "$(get /dashboard/admin/users "$ADMIN")"

npx wrangler d1 execute "$DB" --local -c "$CFG" --command 'DELETE FROM "rateLimit";' >/dev/null 2>&1
TWOFA="$TMP/2fa.txt"
check "login with the right password asks for the second factor"  "/two-factor"     "$(post "$TWOFA" /api/login email=admin@exemplo.com password=senha-longa-o-suficiente)"
check "the temporary cookie does NOT open the dashboard"  "/login?next"       "$(get /dashboard "$TWOFA")"
check "wrong code is refused"                          "e=invalid_code" "$(post "$TWOFA" /api/two-factor action=totp code=000000)"
check "correct code signs in"                          "/dashboard"        "$(post "$TWOFA" /api/two-factor action=totp "code=$(totp_code)")"

npx wrangler d1 execute "$DB" --local -c "$CFG" --command 'DELETE FROM "rateLimit";' >/dev/null 2>&1
RECOVERY="$TMP/recovery.txt"
BACKUP1="$(printf '%s\n' "$CODES_2FA" | sed -n 1p)"
post "$RECOVERY" /api/login email=admin@exemplo.com password=senha-longa-o-suficiente >/dev/null
check "recovery code signs in"                         "/dashboard"        "$(post "$RECOVERY" /api/two-factor action=backup "code=$BACKUP1")"
npx wrangler d1 execute "$DB" --local -c "$CFG" --command 'DELETE FROM "rateLimit";' >/dev/null 2>&1
post "$RECOVERY" /api/login email=admin@exemplo.com password=senha-longa-o-suficiente >/dev/null
check "the same recovery code does not work twice"     "e=invalid_code" "$(post "$RECOVERY" /api/two-factor action=backup "code=$BACKUP1")"

# Without this action, someone who loses the phone AND the codes is locked out forever.
ADMIN_ID="$(id_of admin@exemplo.com)"
check "admin unlocks someone's 2FA"                    "ok=ok_2fa_reset" "$(post "$ADMIN" /api/admin/users action=reset-2fa "userId=$ADMIN_ID" email=admin@exemplo.com)"
check "and the 2FA is gone from the database"          '"twoFactorEnabled": 0' "$(sql "SELECT twoFactorEnabled FROM user WHERE email='admin@exemplo.com'")"
# The admin's session went down with it (the sessions were revoked), so sign in
# again and re-enable 2FA so the rest of the suite can continue.
reset_rate_limit
post "$ADMIN" /api/login email=admin@exemplo.com password=senha-longa-o-suficiente >/dev/null
enable_2fa "$ADMIN" senha-longa-o-suficiente
check "and it can be set up again right after"         '"twoFactorEnabled": 1' "$(sql "SELECT twoFactorEnabled FROM user WHERE email='admin@exemplo.com'")"

echo; echo "$(c 1 'Workspace invariants (in the DATABASE)')"
ADMIN_ID="$(id_of admin@exemplo.com)"
WS_ADMIN="$(sql "SELECT m.organizationId AS id FROM member m WHERE m.userId='$ADMIN_ID'" | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["id"])')"
check "demoting the only owner aborts"                 "LAST_OWNER"       "$(sql_err "UPDATE member SET role='editor' WHERE organizationId='$WS_ADMIN'")"
check "removing the only owner aborts"                 "LAST_OWNER"       "$(sql_err "DELETE FROM member WHERE organizationId='$WS_ADMIN'")"
check "the owner is still standing"                    '"role": "owner"'  "$(sql "SELECT role FROM member WHERE organizationId='$WS_ADMIN'")"
check "made-up platform role is refused"               "PAPEL_PLATAFORMA" "$(sql_err "UPDATE user SET role='readonly' WHERE email='admin@exemplo.com'")"

# Disposable workspace, with no members yet: the role validator can be exercised
# without hitting the last-owner trigger, which fires first on the owner.
sql "INSERT INTO organization (id,name,slug,createdAt) VALUES ('ws_descartavel','Descartável','descartavel',unixepoch())" >/dev/null
check "made-up workspace role is refused"              "PAPEL_INVALIDO"   "$(sql_err "INSERT INTO member (id,organizationId,userId,role,createdAt) VALUES ('m_x','ws_descartavel','$ADMIN_ID','chefe',unixepoch())")"
check "role with a comma is refused"                   "PAPEL_INVALIDO"   "$(sql_err "INSERT INTO member (id,organizationId,userId,role,createdAt) VALUES ('m_y','ws_descartavel','$ADMIN_ID','owner,admin',unixepoch())")"

# The proof that the `EXISTS(... organization ...)` guard in the last-owner
# trigger works: without it the cascade fires LAST_OWNER and deleting a
# workspace becomes IMPOSSIBLE. This check is what prevents that silent regression.
sql "INSERT INTO member (id,organizationId,userId,role,createdAt) VALUES ('m_desc','ws_descartavel','$ADMIN_ID','owner',unixepoch())" >/dev/null
sql_err "DELETE FROM organization WHERE id='ws_descartavel'" >/dev/null
check "deleting a whole workspace WORKS"               "[]"               "$(sql "SELECT id FROM organization WHERE id='ws_descartavel'")"
check "and takes the memberships with it"              "[]"               "$(sql "SELECT id FROM member WHERE organizationId='ws_descartavel'")"

echo; echo "$(c 1 'Last administrator invariant (in the DATABASE)')"
check "demoting the only admin aborts"                 "LAST_ADMIN"       "$(sql_err "UPDATE user SET role='user' WHERE email='admin@exemplo.com'")"
check "banning the only admin aborts"                  "LAST_ADMIN"       "$(sql_err "UPDATE user SET banned=1 WHERE email='admin@exemplo.com'")"
check "deleting the only admin aborts"                 "LAST_ADMIN"       "$(sql_err "DELETE FROM user WHERE email='admin@exemplo.com'")"
check "the admin is still standing"                    '"role": "admin"'  "$(sql "SELECT role FROM user WHERE email='admin@exemplo.com'")"

echo; echo "$(c 1 'Open signup and personal workspace')"
check "the superadmin got a personal workspace"        '"role": "owner"'      "$(sql "SELECT m.role FROM member m JOIN user u ON u.id=m.userId WHERE u.email='admin@exemplo.com'")"
check "and their session already has an active workspace"  '"tem": 1'             "$(sql "SELECT COUNT(*) AS tem FROM session WHERE activeOrganizationId IS NOT NULL")"

post - /api/signup name=Leitor email=leitor@exemplo.com password=outra-senha-bem-longa confirm=outra-senha-bem-longa >/dev/null
check "open signup creates the account"                "leitor@exemplo.com"   "$(sql "SELECT email FROM user WHERE email='leitor@exemplo.com'")"
check "with the e-mail NOT yet verified"               '"emailVerified": 0'   "$(sql "SELECT emailVerified FROM user WHERE email='leitor@exemplo.com'")"
check "and with a personal workspace, as owner"        '"role": "owner"'      "$(sql "SELECT m.role FROM member m JOIN user u ON u.id=m.userId WHERE u.email='leitor@exemplo.com'")"
# Without this, open signup would let anyone sign in with someone else's e-mail.
reset_rate_limit
check "login is BLOCKED before the e-mail is verified"  "e=email_not_verified" "$(post - /api/login email=leitor@exemplo.com password=outra-senha-bem-longa)"

# Signing up with an e-mail that already exists must not reveal that it exists.
check "already registered e-mail answers the SAME as a new one"  "ok=ok_signup"       "$(post - /api/signup name=Impostor email=leitor@exemplo.com password=mais-uma-senha-longa confirm=mais-uma-senha-longa)"
check "and no duplicate account was created"           '"n": 1'               "$(sql "SELECT COUNT(*) AS n FROM user WHERE email='leitor@exemplo.com'")"
check "resending verification answers the same for a nonexistent one"  "ok=ok_verification_resent" "$(post - /api/resend-verification email=ninguem@exemplo.com)"

# Better Auth's own routes are closed to the outside: the forms post to the
# application's endpoints, which call the library from inside. A direct POST to
# /api/auth/sign-up/email used to create an account without going through the
# form (and, before the Turnstile hook, without any challenge); now the route
# does not exist. Only the links of the e-mails and the return from a social
# provider stay open.
raw() { curl -s -o /dev/null -w '%{http_code}' -X "$1" "$BASE/api/auth$2" -H "Origin: $BASE" -H 'Content-Type: application/json' ${3:+-d "$3"}; }
check "the raw sign-up route does not exist"           "404"  "$(raw POST /sign-up/email '{"name":"X","email":"robo@exemplo.com","password":"senha-longa-o-suficiente"}')"
check "and no account was created by it"               "[]"   "$(sql "SELECT id FROM user WHERE email='robo@exemplo.com'")"
check "the raw sign-in route does not exist"           "404"  "$(raw POST /sign-in/email '{"email":"leitor@exemplo.com","password":"qualquer-coisa-longa"}')"
check "nor the raw workspace and admin routes"         "404 404 404" "$(raw POST /organization/create '{"name":"x","slug":"../x"}') $(raw GET '/organization/check-slug?slug=x') $(raw GET /admin/list-users)"
check "the link of a confirmation e-mail still answers" "302" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/auth/verify-email?token=not-a-token&callbackURL=/login")"

# Every check of what was typed happens for both kinds of address. One that
# only a new address went through (a password that is too long) answered
# differently for an address that has an account, which told the two apart.
LONG_PASSWORD="$(python3 -c 'print("z9-" * 80)')"
check "a password that is too long is refused"         "e=password_long"     "$(post - /api/signup name=Novo email=novo-longo@exemplo.com "password=$LONG_PASSWORD" "confirm=$LONG_PASSWORD")"
check "with the SAME answer for an address that has an account"  "e=password_long" "$(post - /api/signup name=Novo email=leitor@exemplo.com "password=$LONG_PASSWORD" "confirm=$LONG_PASSWORD")"
check "a password everybody tries first is refused"    "e=password_common"   "$(post - /api/signup name=Novo email=novo-fraco@exemplo.com password=password123 confirm=password123)"
check "and so is the person's own address with digits"  "e=password_common"  "$(post - /api/signup name=Novo email=mariazinha@exemplo.com password=mariazinha2026 confirm=mariazinha2026)"
check "a name cannot carry a link"                     "e=invalid_name"      "$(post - /api/signup 'name=Visit www.evil.example' email=novo-link@exemplo.com password=uma-senha-bem-longa confirm=uma-senha-bem-longa)"
check "and none of those created an account"           "[]"                  "$(sql "SELECT id FROM user WHERE email LIKE 'novo-%' OR email='mariazinha@exemplo.com'")"

# Usage analytics exist only where a Tag Manager container is configured, and
# the pages say which case they are in. Even with a container, the HTML itself
# never carries the third-party script: the loader waits for the person's yes.
# The pages are read into variables first. A `curl | grep -q` stops reading at
# the first match, curl dies on the closed pipe and, with pipefail, a text that
# IS there reads as missing every now and then.
LOGIN_PAGE="$(curl -s "$BASE/login")"
PRIVACY_PAGE="$(curl -s "$BASE/privacy")"
if [[ "$LOGIN_PAGE" == *clockfolio-consent* ]]; then
  check "with analytics, the privacy page explains them"      "yes" "$(found 'id="analytics"' "$PRIVACY_PAGE")"
  check "and stops promising there are no trackers"           "no"  "$(found 'no trackers' "$PRIVACY_PAGE")"
  check "and no page ships the Tag Manager script directly"   "no"  "$(found_re '<script[^>]+src="https://www.googletagmanager' "$LOGIN_PAGE$PRIVACY_PAGE")"
else
  check "without analytics, no page mentions Tag Manager"     "no"  "$(found 'googletagmanager' "$LOGIN_PAGE$PRIVACY_PAGE")"
  check "and the privacy page keeps the no-trackers promise"  "yes" "$(found 'No ads, no trackers' "$PRIVACY_PAGE")"
fi

sql "UPDATE user SET emailVerified = 1 WHERE email = 'leitor@exemplo.com'" >/dev/null
reset_rate_limit
check "once verified, login goes through"              "/dashboard"           "$(post "$VIEWER" /api/login email=leitor@exemplo.com password=outra-senha-bem-longa)"
check "each person has THEIR OWN workspace"            '"n": 2'               "$(sql "SELECT COUNT(*) AS n FROM organization")"

echo; echo "$(c 1 'Workspace in the URL and isolation')"
WS_ADMIN_SLUG="$(slug_of admin@exemplo.com)"
WS_VIEWER_SLUG="$(slug_of leitor@exemplo.com)"
check "/dashboard leads to the last workspace used"    "/w/"              "$(get /dashboard "$ADMIN")"
check "the owner opens their own workspace"            "200"              "$(get "/w/$WS_ADMIN_SLUG" "$ADMIN")"
check "and its notes"                                  "200"              "$(get "/w/$WS_ADMIN_SLUG/notes" "$ADMIN")"

# 404 and not 403: "no permission" would confirm that the workspace exists,
# which is free information for anyone probing slugs.
check "someone else's workspace answers 404, not 403"  "404"              "$(get "/w/$WS_ADMIN_SLUG" "$VIEWER")"
check "and its notes too"                              "404"              "$(get "/w/$WS_ADMIN_SLUG/notes" "$VIEWER")"
check "the API of someone else's workspace is also 404"  "404"              "$(post "$VIEWER" "/api/w/$WS_ADMIN_SLUG/notes" title=invasao)"
check "a workspace that does not exist is also 404"    "404"              "$(get "/w/isso-nao-existe" "$ADMIN")"

# Content has to stay inside the workspace where it was created.
post "$VIEWER" "/api/w/$WS_VIEWER_SLUG/notes" title=NotaDoLeitor >/dev/null
check "a note created in a workspace stays only in it"  '"n": 1'           "$(sql "SELECT COUNT(*) AS n FROM note n JOIN organization o ON o.id=n.workspaceId WHERE o.slug='$WS_VIEWER_SLUG'")"
check "and does not show up in the other person's workspace"  "[]"               "$(sql "SELECT n.title FROM note n JOIN organization o ON o.id=n.workspaceId WHERE o.slug='$WS_ADMIN_SLUG' AND n.title='NotaDoLeitor'")"

echo; echo "$(c 1 'Roles inside the workspace')"
# The viewer is owner of their own workspace; demoting requires another owner,
# so the test uses a workspace where they are NOT the only owner.
sql "INSERT INTO member (id,organizationId,userId,role,createdAt) VALUES ('m_teste',(SELECT id FROM organization WHERE slug='$WS_ADMIN_SLUG'),(SELECT id FROM user WHERE email='leitor@exemplo.com'),'viewer',unixepoch())" >/dev/null
check "now they can see the admin's workspace"         "200"              "$(get "/w/$WS_ADMIN_SLUG" "$VIEWER")"
check "but as viewer gets 403 when writing"            "403"              "$(post "$VIEWER" "/api/w/$WS_ADMIN_SLUG/notes" title=nao-deveria-passar)"
set_ws_role leitor@exemplo.com "$WS_ADMIN_SLUG" editor
check "promoted to editor, can write"                  "ok=ok_note"       "$(post "$VIEWER" "/api/w/$WS_ADMIN_SLUG/notes" title=AgoraVai)"
sql "DELETE FROM member WHERE id='m_teste'" >/dev/null

echo; echo "$(c 1 'Workspace invitations')"
# A dedicated workspace for these tests: transferring and leaving would leave
# the admin with no workspace at all, and the rest of the suite relies on their
# personal one being intact.
post "$ADMIN" /api/workspaces name="Time de Teste" >/dev/null
WS="$(sql "SELECT slug FROM organization WHERE name='Time de Teste'" | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["slug"])')"
check "creating a workspace works"                     "200"                   "$(get "/w/$WS" "$ADMIN")"
# The page that manages the person's workspaces.
check "the workspaces page lists the new one"          "yes"                   "$(has /workspaces "$ADMIN" "Time de Teste")"
check "and says the owner is alone in it"              "yes"                   "$(has /workspaces "$ADMIN" "Only you")"
check "the only owner is not offered a way out"        "yes"                   "$(has /workspaces "$ADMIN" "You are the only owner")"
# The phone menu: the button and the list it opens are part of every dashboard page.
check "the dashboard carries the phone menu button"    "yes"                   "$(has /workspaces "$ADMIN" 'data-menu-toggle')"
check "and the list that button opens"                 "yes"                   "$(has /workspaces "$ADMIN" 'id="nav-menu"')"

# The time screens keep a copy of the person's own lists in the tab, so they do
# not read the database again on every page (public/app/horas.js). A signed-in
# page says whose copy it is, and the script that empties the copy is on the
# pages of both sides of a sign-out.
check "a signed-in page says whose tab copy it is"     "yes"                   "$(has /workspaces "$ADMIN" "data-person=\"$ADMIN_ID\"")"
check "and loads what empties that copy on sign-out"   "yes"                   "$(has /workspaces "$ADMIN" '/app/forget.js')"
LOGIN_PAGE="$(curl -s "$BASE/login")"
check "the login page empties it too"                  "yes"                   "$(found '/app/forget.js' "$LOGIN_PAGE")"
check "and names no person"                            "no"                    "$(found 'data-person' "$LOGIN_PAGE")"
check "the script that empties it is served"           "200"                   "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/app/forget.js")"

# The Security page lists the sessions of the account. Better Auth's own list
# refuses a session older than `freshAge` (15 minutes) and the page used to die
# with it, a quarter of an hour after every login: the session is aged here.
check "the Security page opens"                        "200"                   "$(get /dashboard/security "$ADMIN")"
sql "UPDATE session SET createdAt = createdAt - 3600 WHERE userId = '$ADMIN_ID'" >/dev/null
SECURITY="$(curl -s -b "$ADMIN" "$BASE/dashboard/security")"
check "and still opens an hour after the login"        "200"                   "$(get /dashboard/security "$ADMIN")"
check "listing the session that asked"                 "yes"                   "$(found 'this session' "$SECURITY")"
check "without handing out any session token"          "no"                    "$(found 'name="token"' "$SECURITY")"

# Deleting a workspace THROUGH THE APP. The SQL check further up only proves the
# cascade; it did not notice that Better Auth's own route removes the
# memberships first and trips the last-owner trigger, so the button always
# failed. This goes through the real endpoint.
post "$ADMIN" /api/workspaces name="Para Apagar" >/dev/null
WS_DEL="$(sql "SELECT slug FROM organization WHERE name='Para Apagar'" | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["slug"])')"
ID_DEL="$(sql "SELECT id FROM organization WHERE name='Para Apagar'" | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["id"])')"
check "deleting asks for the name typed right"         "e=confirm_name"        "$(post "$ADMIN" "/api/w/$WS_DEL/workspace" action=delete confirmation=errado)"
check "and nothing is recorded as deleted yet"         "[]"                    "$(sql "SELECT id FROM audit_log WHERE action='workspace.deleted'")"
check "the owner deletes the workspace in the app"     "ok=ok_workspace_deleted" "$(post "$ADMIN" "/api/w/$WS_DEL/workspace" action=delete "confirmation=Para Apagar")"
check "and it is really gone"                          "[]"                    "$(sql "SELECT id FROM organization WHERE id='$ID_DEL'")"
check "with its memberships"                           "[]"                    "$(sql "SELECT id FROM member WHERE organizationId='$ID_DEL'")"
check "no session still points at it"                  "[]"                    "$(sql "SELECT id FROM session WHERE activeOrganizationId='$ID_DEL'")"
check "the audit trail says who deleted what"          "para-apagar"           "$(sql "SELECT details FROM audit_log WHERE action='workspace.deleted'")"
check "the list no longer shows it"                    "no"                    "$(has /workspaces "$ADMIN" "Para Apagar")"
check "admin invites someone as editor"                "ok=ok_invite_sent" "$(post "$ADMIN" "/api/w/$WS/invites" action=invite email=leitor@exemplo.com role=editor)"
check "inviting again is blocked"                      "e=invite_pending"    "$(post "$ADMIN" "/api/w/$WS/invites" action=invite email=leitor@exemplo.com role=editor)"
check "inviting as owner is refused"                   "e=invalid_role"      "$(post "$ADMIN" "/api/w/$WS/invites" action=invite email=outra@exemplo.com role=owner)"
check "made-up role is refused"                        "e=invalid_role"      "$(post "$ADMIN" "/api/w/$WS/invites" action=invite email=outra@exemplo.com role=chefe)"

INVITE="$(invite_id leitor@exemplo.com)"
check "the invitation is pending in the database"      "pending"              "${INVITE:+pending}"
check "the invitation page is public"                  "200"                   "$(get "/invite/$INVITE")"

# The notice in the dashboard. Without it, the only path to an invitation is
# the e-mail link, and someone who deleted the message is stuck, even while
# already signed in.
check "the invitee sees the notice in the dashboard"   "yes"                   "$(has /dashboard/profile "$VIEWER" "waiting")"
check "and the notice names the workspace"             "yes"                   "$(has /dashboard/profile "$VIEWER" "Time de Teste")"
check "someone who was not invited sees no notice at all"  "no"                    "$(has /dashboard/profile "$ADMIN" "waiting")"

# The central guard: the invitation belongs to the e-mail that received it, and to nobody else.
check "accepting with the WRONG account is refused"    "e=not_recipient"  "$(post "$ADMIN" /api/invite/accept "id=$INVITE")"
check "and nobody joined the workspace because of it"  '"n": 1'                "$(sql "SELECT COUNT(*) AS n FROM member m JOIN organization o ON o.id=m.organizationId WHERE o.slug='$WS'")"

check "accepting with the right account works"         "ok=ok_invite_accepted"  "$(post "$VIEWER" /api/invite/accept "id=$INVITE")"
check "the workspaces page counts the new member"     "yes"                   "$(has /workspaces "$ADMIN" "2 people")"
check "and offers the member a way out"                "yes"                   "$(has /workspaces "$VIEWER" "action=\"/api/w/$WS/members\"")"
check "and the role came from the INVITATION"          '"role": "editor"'      "$(role_of leitor@exemplo.com "$WS")"
check "now they can open the workspace"                "200"                   "$(get "/w/$WS" "$VIEWER")"
check "and can write, as editor"                       "ok=ok_note"            "$(post "$VIEWER" "/api/w/$WS/notes" title=DoEditor)"
check "but an editor does NOT invite anyone"           "403"                   "$(post "$VIEWER" "/api/w/$WS/invites" action=invite email=x@y.com role=viewer)"
check "and does NOT delete the workspace"              "403"                   "$(post "$VIEWER" "/api/w/$WS/workspace" action=delete "confirmation=Time de Teste")"

check "the notice disappears after accepting"          "no"                    "$(has /dashboard/profile "$VIEWER" "waiting")"
# The plugin marks the freshly accepted workspace as active, so /dashboard
# leads into it instead of sending back to the personal workspace.
check "and the dashboard already lands inside the accepted workspace"  "/w/$WS"                "$(get /dashboard "$VIEWER")"
check "and the confirmation survives the jump"         "ok=ok_invite_accepted"  "$(get "/dashboard?ok=ok_invite_accepted" "$VIEWER")"
check "but an unknown query param does not hitch a ride"  "/w/$WS/time?ok="      "$(get "/dashboard?lixo=abc&ok=ok_invite_accepted" "$VIEWER")"

# The notice is keyed on the e-mail: a third party's invitation must not show up for me.
post "$ADMIN" "/api/w/$WS/invites" action=invite email=ninguem@exemplo.com role=viewer >/dev/null
check "an invitation addressed to ANOTHER person does not leak"  "no"                    "$(has /dashboard/profile "$VIEWER" "waiting")"


# Resending and cancelling act on the invitation the id names, with the address
# and the role it has in the database. The Resend button used to send no id at
# all (so it always failed), and the endpoint took the role from the form,
# which was a way around "nobody invites to owner".
INVITE_RESEND="$(invite_id ninguem@exemplo.com)"
check "the Resend button names the invitation"         "yes"                   "$(has "/w/$WS/members" "$ADMIN" "name=\"id\" value=\"$INVITE_RESEND\"")"
check "resending by id works"                          "ok=ok_invite_sent"     "$(post "$ADMIN" "/api/w/$WS/invites" action=resend "id=$(invite_id ninguem@exemplo.com)" role=owner email=outra-pessoa@exemplo.com)"
check "the role in the form changed nothing"           '"role": "viewer"'      "$(sql "SELECT role FROM org_invitation WHERE email='ninguem@exemplo.com' AND status='pending'")"
check "nor did the address in the form"                "[]"                    "$(sql "SELECT id FROM org_invitation WHERE email='outra-pessoa@exemplo.com'")"
check "an invitation from nowhere is refused"          "e=invite_expired"      "$(post "$ADMIN" "/api/w/$WS/invites" action=cancel id=nao-existe)"

echo; echo "$(c 1 'Member management')"
ID_VIEWER="$(member_id leitor@exemplo.com "$WS")"
ID_ADMIN="$(member_id admin@exemplo.com "$WS")"
check "admin demotes the editor to viewer"             "ok=ok_member_role"    "$(post "$ADMIN" "/api/w/$WS/members" action=role "memberId=$ID_VIEWER" role=viewer)"
check "as viewer, writing gets 403"                    "403"                   "$(post "$VIEWER" "/api/w/$WS/notes" title=nao-deveria)"
check "nobody changes their own role"                  "e=own_membership"      "$(post "$ADMIN" "/api/w/$WS/members" action=role "memberId=$ID_ADMIN" role=viewer)"
check "and nobody becomes owner through a role change"  "e=invalid_role"      "$(post "$ADMIN" "/api/w/$WS/members" action=role "memberId=$ID_VIEWER" role=owner)"

# Transfer: promote first, demote afterwards. In the reverse order the trigger
# would abort, because the workspace would be left without an owner midway.
check "owner transfers ownership"                      "ok=ok_transferred"     "$(post "$ADMIN" "/api/w/$WS/members" action=transfer "memberId=$ID_VIEWER" "myMemberId=$ID_ADMIN")"
check "the recipient became owner"                     '"role": "owner"'       "$(role_of leitor@exemplo.com "$WS")"
check "the one who transferred became admin"           '"role": "admin"'       "$(role_of admin@exemplo.com "$WS")"
check "and the workspace still has a single owner"     '"n": 1'                "$(sql "SELECT COUNT(*) AS n FROM member m JOIN organization o ON o.id=m.organizationId WHERE o.slug='$WS' AND m.role='owner'")"

# A personal token belongs to one membership. It used to stay in the table
# after the person left, and came back to life if they were invited again.
TOKEN_SMOKE="$(curl -s -b "$ADMIN" -X POST "$BASE/api/w/$WS/tokens" -H "Origin: $BASE" -H 'Content-Type: application/json' -d '{"action":"create","name":"smoke"}' | python3 -c 'import sys,json;print(json.load(sys.stdin).get("token",""))')"
check "a member creates a personal token"              '"n": 1'                "$(sql "SELECT COUNT(*) AS n FROM api_token WHERE userId='$ADMIN_ID'")"
check "the token API answers a DELETE with no Content-Type"  "404"             "$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$BASE/api/v1/entries/999999" -H "Authorization: Bearer $TOKEN_SMOKE")"

# The time API behind that token. The project list comes with the sums of the
# entries, or without them for whoever only needs the projects themselves, a
# picker or a filter. And the screen that checks every minute compares one
# mark instead of loading everything again.
tk() { curl -s "$BASE/api/v1$1" -H "Authorization: Bearer $TOKEN_SMOKE" ${2:+-X "$2"} ${3:+-H 'Content-Type: application/json' -d "$3"}; }
field() { python3 -c 'import sys,json;print(json.load(sys.stdin).get(sys.argv[1],""))' "$1"; }
PROJECT_ID="$(tk /projects POST '{"name":"Smoke project"}' | field id)"
MARK_BEFORE="$(tk /status | field revision)"
check "an entry goes on a project by its id"            '"project":"Smoke project"'  "$(tk /entries POST "{\"project_id\":$PROJECT_ID,\"duration_minutes\":30,\"tags\":[\"smoke-tag\"]}")"
check "a project that does not exist is refused"        "404"                   "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/v1/entries" -H "Authorization: Bearer $TOKEN_SMOKE" -H 'Content-Type: application/json' -d '{"project_id":999999,"duration_minutes":5}')"
MARK_AFTER="$(tk /status | field revision)"
check "the status mark changes when an entry does"      "changed"               "$([[ -n "$MARK_AFTER" && "$MARK_AFTER" != "$MARK_BEFORE" ]] && echo changed || echo same)"
check "and stays the same while nothing changes"        "same"                  "$([[ "$(tk /status | field revision)" == "$MARK_AFTER" ]] && echo same || echo changed)"
check "the project list carries the sums of the entries"  '"total_seconds":1800'  "$(tk /projects)"
PLAIN_LIST="$(tk '/projects?totals=0')"
check "and comes without them when asked"               "plain"                 "$([[ "$PLAIN_LIST" == *'"name":"Smoke project"'* && "$PLAIN_LIST" != *total_seconds* ]] && echo plain || echo "with sums")"
check "one project answers with its own sums"           '"entries":1'           "$(tk "/projects/$PROJECT_ID")"
check "a timer starts on a project by its id"           '"project":"Smoke project"'  "$(tk /timer/start POST "{\"project_id\":$PROJECT_ID}")"
check "and stops"                                       '"running":false'       "$(tk /timer/stop POST '{}')"
check "the tag list has the tag that was used"          '"tag":"smoke-tag"'     "$(tk /tags)"

# The sums of a project. They are not added up from the entries on every read
# (that read one row per entry of the workspace, and the database limits the
# rows read): the database keeps them per project and person, and triggers
# move them with every change of an entry (migration 0013). So here two people
# work on the same project and an entry goes through everything that can
# happen to one, and each answer has to be what the entries add up to.
TOKEN_OTHER="$(curl -s -b "$VIEWER" -X POST "$BASE/api/w/$WS/tokens" -H "Origin: $BASE" -H 'Content-Type: application/json' -d '{"action":"create","name":"smoke"}' | python3 -c 'import sys,json;print(json.load(sys.stdin).get("token",""))')"
tk2() { curl -s "$BASE/api/v1$1" -H "Authorization: Bearer $TOKEN_OTHER" ${2:+-X "$2"} ${3:+-H 'Content-Type: application/json' -d "$3"}; }
sums() { # sums: the five numbers of a project that come from the entries, read from its JSON
  python3 -c 'import sys,json;p=json.load(sys.stdin);print("seconds=%s entries=%s billable=%s hours=%s amount=%s;" % (p["total_seconds"], p["entries"], p["billable_entries"], p["spent_hours"], p["spent_amount"]))'
}
ONE="$(tk /projects POST '{"name":"Totals one","hourly_rate":100,"budget_hours":10}' | field id)"
TWO="$(tk /projects POST '{"name":"Totals two","hourly_rate":60}' | field id)"
ENTRY="$(tk /entries POST "{\"project_id\":$ONE,\"start\":\"2026-11-02T09:00:00Z\",\"end\":\"2026-11-02T10:00:00Z\",\"billable\":true}" | field id)"
tk2 /entries POST "{\"project_id\":$ONE,\"start\":\"2026-11-02T09:00:00Z\",\"end\":\"2026-11-02T09:30:00Z\"}" >/dev/null
check "a project has this person's time and everybody's spending"  "seconds=3600 entries=1 billable=1 hours=1.5 amount=100;"  "$(tk "/projects/$ONE" | sums)"
check "the other person sees their own time, the same spending"  "seconds=1800 entries=1 billable=0 hours=1.5 amount=100;"  "$(tk2 "/projects/$ONE" | sums)"
check "the list answers the same as the project alone"  "same"  "$(python3 -c 'import sys,json;one=json.loads(sys.argv[2]);print("same" if [p for p in json.loads(sys.argv[1]) if p["id"]==one["id"]]==[one] else "different")' "$(tk /projects)" "$(tk "/projects/$ONE")")"
tk "/entries/$ENTRY" PATCH '{"end":"2026-11-02T11:00:00Z"}' >/dev/null
check "an entry made longer counts for its new time"    "seconds=7200 entries=1 billable=1 hours=2.5 amount=200;"  "$(tk "/projects/$ONE" | sums)"
tk "/entries/$ENTRY" PATCH '{"billable":false}' >/dev/null
check "and costs nothing once it is not billable"       "seconds=7200 entries=1 billable=0 hours=2.5 amount=0;"    "$(tk "/projects/$ONE" | sums)"
tk "/entries/$ENTRY" PATCH "{\"project_id\":$TWO,\"billable\":true}" >/dev/null
check "moved, an entry leaves one project"              "seconds=0 entries=0 billable=0 hours=0.5 amount=0;"       "$(tk "/projects/$ONE" | sums)"
check "and enters the other"                            "seconds=7200 entries=1 billable=1 hours=2 amount=120;"    "$(tk "/projects/$TWO" | sums)"
# A running timer is an entry already, and its time is added when someone asks.
tk /timer/start POST "{\"project_id\":$TWO,\"start\":\"2026-11-02T12:00:00Z\"}" >/dev/null
RUNNING="$(tk "/projects/$TWO")"
check "a running timer counts as an entry"              '"entries":2'  "$RUNNING"
check "with the time it has so far"                     "yes"          "$(python3 -c 'import sys,json;print("yes" if json.loads(sys.argv[1])["total_seconds"] > 7200 + 86400 else "no")' "$RUNNING")"
tk /timer/stop POST '{"end":"2026-11-02T12:10:00Z"}' >/dev/null
check "stopped, it counts for exactly its time"         "seconds=7800 entries=2 billable=1 hours=2.17 amount=120;" "$(tk "/projects/$TWO" | sums)"
# "Billable by default", applied to the entries that exist. The answer counts
# the entries: the database's own count of changed rows also includes the row
# of sums a trigger updates for each of them, and said twice as many.
APPLIED="$(tk "/projects/$TWO" PATCH '{"billable":true,"apply_to_entries":true}')"
check "applying billable to old entries counts the entries"  '"entries_updated":1'  "$APPLIED"
check "and the sums follow"                             "seconds=7800 entries=2 billable=2 hours=2.17 amount=130;" "$(printf '%s' "$APPLIED" | sums)"
# An import adds the sums of a whole batch at once, not entry by entry.
printf '%s\n' 'description,project,start,end,billable' \
  'from a file,Totals two,2026-11-03T09:00:00Z,2026-11-03T09:15:00Z,yes' \
  'on a new project,Totals imported,2026-11-03T10:00:00Z,2026-11-03T10:20:00Z,no' \
  'on no project,,2026-11-03T11:00:00Z,2026-11-03T11:05:00Z,no' > "$TMP/import.csv"
check "a file is imported"                              '"imported":3'  "$(curl -s -X POST "$BASE/api/v1/import" -H "Authorization: Bearer $TOKEN_SMOKE" -H 'Content-Type: text/csv' --data-binary @"$TMP/import.csv")"
check "its entries are in the sums of their project"    "seconds=8700 entries=3 billable=3 hours=2.42 amount=145;" "$(tk "/projects/$TWO" | sums)"
IMPORTED="$(tk '/projects?totals=0' | python3 -c 'import sys,json;print([p["id"] for p in json.load(sys.stdin) if p["name"]=="Totals imported"][0])')"
check "and a project the file created has its own"      "seconds=1200 entries=1 billable=0 hours=0.33 amount=0;"   "$(tk "/projects/$IMPORTED" | sums)"
tk "/entries/$ENTRY" DELETE >/dev/null
check "a deleted entry leaves the sums"                 "seconds=1500 entries=2 billable=2 hours=0.42 amount=25;"  "$(tk "/projects/$TWO" | sums)"
check "what the database keeps is what the entries add up to"  '"missing": 0, "extra": 0'  "$(totals_state)"
tk "/projects/$TWO" DELETE >/dev/null
check "a deleted project leaves its entries, without a project"  '"n": 3'  "$(sql "SELECT COUNT(*) AS n FROM time_entry e JOIN organization o ON o.id = e.workspaceId WHERE o.slug = '$WS' AND e.projectId IS NULL")"
check "and takes its sums along, and only its own"      '"missing": 0, "extra": 0'  "$(totals_state)"
check "the other project still answers as before"       "seconds=0 entries=0 billable=0 hours=0.5 amount=0;"       "$(tk "/projects/$ONE" | sums)"
# When a project goes, the database itself looks for the entries that point to
# it, by the project alone. Without an index that begins with the project it
# walked through every entry of every workspace to find them, twice, even for
# a project with no entries (migration 0014).
PLAN="$(sql "EXPLAIN QUERY PLAN DELETE FROM time_project WHERE id = $ONE")"
check "deleting a project finds its entries through an index"  "time_entry_project_owner_start_idx (projectId=?)"  "$PLAN"
check "and does not walk through all the entries"       "no"            "$(found 'SCAN time_entry' "$PLAN")"

# Importing again. A row of a file repeats a stored entry when the start, the
# end and the description are all the same, for the same person, and such a
# row is skipped. The stored entries are no longer read from the first to the
# last date of the file whatever lies in between (two rows years apart made
# that the person's whole history). They are read between those dates only
# while that is no more than the file has rows, and start by start otherwise.
# Both ways have to tell the same duplicates.
imp() { curl -s -X POST "$BASE/api/v1/import${2:-}" -H "Authorization: Bearer ${3:-$TOKEN_SMOKE}" -H 'Content-Type: text/csv' --data-binary @"$1"; }
# Three entries are stored between 09:00 and 11:00 and this file has two
# starts: they are looked up start by start.
printf '%s\n' 'description,project,start,end,billable' \
  'from a file,,2026-11-03T09:00:00Z,2026-11-03T09:15:00Z,yes' \
  'from a file,,2026-11-03T09:00:00Z,2026-11-03T09:16:00Z,yes' \
  'from another file,,2026-11-03T09:00:00Z,2026-11-03T09:15:00Z,yes' \
  'from a file,,2026-11-03T09:00:00Z,2026-11-03T09:16:00Z,yes' \
  'on no project,,2026-11-03T11:00:00Z,2026-11-03T11:05:00Z,no' > "$TMP/again.csv"
AGAIN="$(imp "$TMP/again.csv" '?dry_run=1')"
check "the same start with another end or description is a new entry"  '"to_import":2'  "$AGAIN"
check "a stored entry and a row repeated in the file are duplicates"   '"duplicates":3' "$AGAIN"
check "for another person none of it is stored"         '"to_import":4'  "$(imp "$TMP/again.csv" '?dry_run=1' "$TOKEN_OTHER")"
# This one has four starts for the same three entries: one read of the stretch.
printf '%s\n' 'description,project,start,end,billable' \
  'from a file,,2026-11-03T09:00:00Z,2026-11-03T09:15:00Z,yes' \
  'on a new project,,2026-11-03T10:00:00Z,2026-11-03T10:20:00Z,no' \
  'on no project,,2026-11-03T11:00:00Z,2026-11-03T11:05:00Z,no' \
  'later that day,,2026-11-03T12:00:00Z,2026-11-03T12:05:00Z,no' > "$TMP/stretch.csv"
STRETCH="$(imp "$TMP/stretch.csv" '?dry_run=1')"
check "a file that covers one stretch tells the same duplicates"  '"duplicates":3'  "$STRETCH"
check "and what is new in it"                           '"to_import":1'  "$STRETCH"
check "the new rows are imported"                       '"imported":2'   "$(imp "$TMP/again.csv")"
check "and are duplicates from then on"                 '"duplicates":5' "$(imp "$TMP/again.csv")"
# An import refuses to take a workspace past its limit of entries. It counts
# them without walking through them all: the ones on a project are in the
# sums the database keeps, the ones on no project come from the index.
check "the count an import uses is the number of entries"  '"differ": 0'  "$(sql "SELECT COUNT(*) AS differ FROM organization o
         WHERE (SELECT COUNT(*) FROM time_entry e WHERE e.workspaceId = o.id)
            != (SELECT COALESCE(SUM(entries), 0) FROM time_project_total t WHERE t.workspaceId = o.id)
             + (SELECT COUNT(*) FROM time_entry e WHERE e.workspaceId = o.id AND e.projectId IS NULL)")"

check "now the former owner can leave"                 "ok=ok_left"            "$(post "$ADMIN" "/api/w/$WS/members" action=leave)"
check "and loses access immediately"                   "404"                   "$(get "/w/$WS" "$ADMIN")"
check "and their token for it is gone"                 '"n": 0'                "$(sql "SELECT COUNT(*) AS n FROM api_token WHERE userId='$ADMIN_ID'")"
check "so it opens nothing any more"                   "401"                   "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/v1/status" -H "Authorization: Bearer $TOKEN_SMOKE")"

# The sole owner of their own personal workspace cannot leave: it would be
# orphaned. The trigger guarantees this, not the application.
WS_VIEWER="$(slug_of leitor@exemplo.com)"
check "the last owner cannot leave"                    "e="                    "$(post "$VIEWER" "/api/w/$WS_VIEWER/members" action=leave)"
check "and is still the owner"                         '"role": "owner"'       "$(role_of leitor@exemplo.com "$WS_VIEWER")"

echo; echo "$(c 1 'Platform authorization')"
ADMIN_ID="$(id_of admin@exemplo.com)"
check "regular user gets 403 on /api/admin/users"   "403"              "$(post "$VIEWER" /api/admin/users action=role userId=x role=admin)"
check "and is redirected away from /dashboard/admin"   "e=no_permission"  "$(get /dashboard/admin/users "$VIEWER")"
check "but DOES change their own password (account:write)"  "ok=ok_password"      "$(post "$VIEWER" /api/security/password current_password=outra-senha-bem-longa new_password=senha-nova-do-leitor confirm=senha-nova-do-leitor)"
check "admin creates a note in their workspace"        "ok=ok_note"       "$(post "$ADMIN" "/api/w/$(slug_of admin@exemplo.com)/notes" title=Nota "body=do admin")"
check "admin does not change their own role"           "e=own_role"  "$(post "$ADMIN" /api/admin/users action=role "userId=$ADMIN_ID" role=user)"
check "admin does not disable their own account"       "e=own_status" "$(post "$ADMIN" /api/admin/users action=disable "userId=$ADMIN_ID")"

echo; echo "$(c 1 'Static files do not go through the login gate')"
check "nonexistent file gives 404, not a redirect"    "404"              "$(get /favicon.ico)"
check "another nonexistent file too"                  "404"              "$(get /nao-existe.txt)"
check "the project favicon is served"                 "200"              "$(get /favicon.svg)"
check "but /dashboard/*.json still requires a session"  "/login?next"      "$(get /dashboard/relatorio.json)"

echo; echo "$(c 1 'One address')"
# The development server has a local address, where nothing is redirected. So
# the rule is exercised on the function the middleware calls, with addresses
# that only exist in production.
elsewhere() { # elsewhere <request URL> <site address>: where the request is sent, or "stays"
  node -e "import('./src/lib/address.ts').then(m => console.log(m.elsewhere(new URL(process.argv[1]), process.argv[2]) ?? 'stays'))" "$1" "$2"
}
check "another host goes to the same page of the site" "https://app.example/w/a?from=1" "$(elsewhere 'https://app.example.workers.dev/w/a?from=1' https://app.example)"
check "the site's own address stays"                   "stays"            "$(elsewhere https://app.example/login https://app.example)"
check "a local request is never sent away"             "stays"            "$(elsewhere http://127.0.0.1:4321/login https://app.example)"
check "and nothing is while the site address is local" "stays"            "$(elsewhere https://app.example/login http://localhost:4321)"
check "this server answers where it was called"        "200"              "$(get /privacy)"


echo; echo "$(c 1 'HTTPS, headers and where a request comes from')"
# Same as above: the rule only acts on a site that has HTTPS, so it is
# exercised on the function the middleware calls.
over_http() { # over_http <request URL> <site address> [X-Forwarded-Proto]: "to https" or "stays"
  node -e "import('./src/lib/address.ts').then(m => console.log(m.overPlainHttp(new URL(process.argv[1]), new Headers(process.argv[3] ? { 'x-forwarded-proto': process.argv[3] } : {}), process.argv[2]) ? 'to https' : 'stays'))" "$1" "$2" "${3:-}"
}
check "plain HTTP at a site with HTTPS is sent to HTTPS"  "to https"       "$(over_http http://app.example/login https://app.example)"
check "a request that came over HTTPS stays"           "stays"            "$(over_http https://app.example/login https://app.example)"
check "a proxy saying the visitor used HTTPS is believed"  "stays"        "$(over_http http://app.example/login https://app.example https)"
check "and nothing local is ever sent anywhere"        "stays"            "$(over_http http://localhost:4321/login https://app.example)"

HEADERS_PAGE="$(curl -s -o /dev/null -D - "$BASE/login" | tr 'A-Z' 'a-z')"
check "a page cannot be put inside a frame"            "x-frame-options: deny"            "$HEADERS_PAGE"
check "by either of the two ways of saying it"         "frame-ancestors 'none'"           "$HEADERS_PAGE"
check "and is read as the type it declares"            "x-content-type-options: nosniff"  "$HEADERS_PAGE"
# A static file is answered by Cloudflare's assets handler, which reads
# public/_headers. `astro dev` (what the CI starts) serves static files through
# Vite and never reads that file, so there the header cannot be asked of the
# server: the suite checks the rule the deploy will read instead.
if [[ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/@vite/client")" == "200" ]]; then
  check "a static file gets the same from public/_headers"  "x-content-type-options: nosniff"  "$(tr 'A-Z' 'a-z' < public/_headers)"
else
  check "a static file carries the same"               "x-content-type-options: nosniff"  "$(curl -s -o /dev/null -D - "$BASE/favicon.svg" | tr 'A-Z' 'a-z')"
fi
check "a page drawn for a signed-in person is not cached"  "cache-control: no-store"      "$(curl -s -o /dev/null -D - -b "$ADMIN" "$BASE/dashboard/profile" | tr 'A-Z' 'a-z')"

# The origin check is the application's own now (see src/middleware.ts): every
# request that changes something, whatever its content type, except on the
# routes called with a personal token.
check "a POST from nowhere is refused, JSON included"  "403"              "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/login" -H 'Content-Type: application/json' -d '{}')"
check "and so is one from another site"                "403"              "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/login" -H 'Origin: https://evil.example' --data-urlencode email=a@b.co)"
check "the token API does not ask a program for an origin"  "401"         "$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$BASE/api/v1/entries/1" -H 'Authorization: Bearer hrs_made_up')"

echo; echo "$(c 1 'Credentials and anti-enumeration')"
npx wrangler d1 execute "$DB" --local -c "$CFG" --command 'DELETE FROM "rateLimit";' >/dev/null 2>&1
check "new password works"                             "/dashboard"     "$(post - /api/login email=leitor@exemplo.com password=senha-nova-do-leitor)"
check "old password no longer works"                   "e=credentials"  "$(post - /api/login email=leitor@exemplo.com password=outra-senha-bem-longa)"
check "nonexistent e-mail gives the SAME message"      "e=credentials"  "$(post - /api/login email=ninguem@exemplo.com password=qualquer-coisa-longa)"
check "forgot-password: nonexistent answers success"   "ok=ok_reset"    "$(post - /api/forgot-password email=ninguem@exemplo.com)"
check "forgot-password: real e-mail answers the same"  "ok=ok_reset"    "$(post - /api/forgot-password email=admin@exemplo.com)"
# `next` is where the login sends the person afterwards. A backslash counts
# as a slash for a browser, so `/\host` is another site.
check "the login never sends anyone to another site"   "next=%2Fdashboard&" "$(post - /api/login email=leitor@exemplo.com 'next=/\evil.example')"
check "nor to an endpoint"                             "next=%2Fdashboard&" "$(post - /api/login email=leitor@exemplo.com next=/api/logout)"
check "a page of the site is kept"                     "next=%2Fw%2Fa%2Ftime&" "$(post - /api/login email=leitor@exemplo.com next=/w/a/time)"

echo; echo "$(c 1 'Social login')"
# The providers only exist when the key pair is configured, so the suite
# checks the correct behavior for the environment it is running in. It looks
# for the FORM, not for the route's name: the analytics script mentions the
# route too, and would make a deploy without keys look like one with them.
if [[ "$(curl -s "$BASE/login")" == *'action="/api/social"'* ]]; then
  check "Google starts the OAuth flow"                 "accounts.google.com"    "$(curl -s -o /dev/null -D - -X POST "$BASE/api/social" -H "Origin: $BASE" --data-urlencode provider=google | grep -i '^location:')"
  check "and the state/PKCE cookie goes along"         "set-cookie"             "$(curl -s -o /dev/null -D - -X POST "$BASE/api/social" -H "Origin: $BASE" --data-urlencode provider=google | grep -io '^set-cookie' | head -1)"
else
  check "without keys, the social buttons do not show up"  "0"                      "$(curl -s "$BASE/login" | grep -c 'action="/api/social"')"
  check "without keys, the social route refuses"       "e=social_unavailable"  "$(post - /api/social provider=google)"
fi
check "unknown provider is refused"                    "e=social_unavailable"  "$(post - /api/social provider=facebook)"

# The second factor after a social sign-in. The library only asks for the code
# after a password sign-in, so an account with two-step verification on could
# be entered through its Google or GitHub login without the code. A real return
# from a provider cannot be produced on this machine (their addresses are fixed
# inside the library), so the library itself is run with the network faked, with
# the same change the app applies (see scripts/social-2fa-check.mjs).
SOCIAL_2FA="$(node scripts/social-2fa-check.mjs 2>/dev/null)"
check "a social sign-in does not let in an account with 2FA"  "ok coming back from the provider opens NO session" "$SOCIAL_2FA"
check "it sends the person to the code page"           "ok the person is sent to the code page"   "$SOCIAL_2FA"
check "remembering where they were going"              "ok which remembers where they were going" "$SOCIAL_2FA"
check "a wrong code opens nothing"                     "ok a wrong code still opens nothing"       "$SOCIAL_2FA"
check "and the right one opens the session"            "ok the right code opens the session"       "$SOCIAL_2FA"
check "an account without 2FA signs in as before"      "ok an account without two-step verification goes straight in" "$SOCIAL_2FA"
check "and nothing else in that run failed"            "social-2fa: all ok"                        "$SOCIAL_2FA"
# The return from a provider is still a route that exists; with nothing in it,
# the library says what is missing instead of the app answering "not found".
check "the return route still answers"                 "302"                   "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/auth/callback/google")"

echo; echo "$(c 1 'Security controls')"

# --- full password recovery cycle ---
reset_rate_limit
sql "DELETE FROM verification" >/dev/null
post - /api/forgot-password email=leitor@exemplo.com >/dev/null
TOKEN_RESET="$(sql "SELECT identifier FROM verification WHERE identifier LIKE 'reset-password:%'" \
  | python3 -c "import sys,json;r=json.load(sys.stdin);print(r[0]['identifier'].split(':',1)[1] if r else '')")"
check "the recovery request generates a token"        "ok"             "${TOKEN_RESET:+ok}"
check "resetting with the token works"                "ok=ok_password"    "$(post - /api/reset-password "token=$TOKEN_RESET" password=senha-redefinida-aqui confirm=senha-redefinida-aqui)"
reset_rate_limit
check "the new password signs in"                     "/dashboard"     "$(post - /api/login email=leitor@exemplo.com password=senha-redefinida-aqui)"
check "the previous password is dead"                 "e=credentials"  "$(post - /api/login email=leitor@exemplo.com password=senha-nova-do-leitor)"
check "the same recovery token does not work twice"   "e="             "$(post - /api/reset-password "token=$TOKEN_RESET" password=outra-senha-qualquer confirm=outra-senha-qualquer)"

# --- revoking sessions must really kill them, not just clear the table ---
reset_rate_limit
LIVE="$TMP/live.txt"
post "$LIVE" /api/login email=leitor@exemplo.com password=senha-redefinida-aqui >/dev/null
check "the freshly created session works"             "/w/"            "$(get /dashboard "$LIVE")"
post "$ADMIN" /api/admin/users action=revoke-sessions "userId=$(id_of leitor@exemplo.com)" email=leitor@exemplo.com >/dev/null
check "admin revokes and the session dies immediately"  "/login?next"    "$(get /dashboard "$LIVE")"

# --- a disabled account loses access ---
reset_rate_limit
post "$ADMIN" /api/admin/users action=disable "userId=$(id_of leitor@exemplo.com)" email=leitor@exemplo.com >/dev/null
check "disabled account cannot sign in"               "e=credentials"  "$(post - /api/login email=leitor@exemplo.com password=senha-redefinida-aqui)"
post "$ADMIN" /api/admin/users action=enable "userId=$(id_of leitor@exemplo.com)" email=leitor@exemplo.com >/dev/null
reset_rate_limit
check "re-enabled, it can sign in again"              "/dashboard"     "$(post - /api/login email=leitor@exemplo.com password=senha-redefinida-aqui)"

# --- changing the password must kill the OTHER sessions and keep the current one ---
reset_rate_limit
SESSION_A="$TMP/sa.txt"; SESSION_B="$TMP/sb.txt"
post "$SESSION_A" /api/login email=leitor@exemplo.com password=senha-redefinida-aqui >/dev/null
reset_rate_limit
post "$SESSION_B" /api/login email=leitor@exemplo.com password=senha-redefinida-aqui >/dev/null
check "two simultaneous sessions work"                "/w/"            "$(get /dashboard "$SESSION_A")"
post "$SESSION_B" /api/security/password current_password=senha-redefinida-aqui new_password=senha-final-do-leitor confirm=senha-final-do-leitor >/dev/null
check "changing the password kills the OTHER session"  "/login?next"    "$(get /dashboard "$SESSION_A")"
check "and keeps the session that changed it alive"   "/w/"            "$(get /dashboard "$SESSION_B")"

# --- unlocking 2FA for someone who does not have it ---
# Here, and not in the 2FA section: there the admin had just unlocked their own
# account, which revokes their sessions, so the next call came without a session.
check "unlocking someone without 2FA is refused"      "e=no_2fa"      "$(post "$ADMIN" /api/admin/users action=reset-2fa "userId=$(id_of leitor@exemplo.com)" email=leitor@exemplo.com)"

# --- an e-mail change must not take effect before confirmation ---
post "$ADMIN" /api/security/email email=outro@exemplo.com >/dev/null
check "requesting an e-mail change does NOT change the e-mail"  "admin@exemplo.com"   "$(sql "SELECT email FROM user WHERE id = '$(id_of admin@exemplo.com)'")"

echo; echo "$(c 1 'LGPD: export and delete')"
reset_rate_limit
LGPD="$TMP/lgpd.txt"
post "$LGPD" /api/login email=leitor@exemplo.com password=senha-final-do-leitor >/dev/null
EXPORT="$(curl -s -b "$LGPD" "$BASE/api/account/export")"
check "the export answers JSON"                        '"account"'            "$EXPORT"
check "with the person's e-mail"                       "leitor@exemplo.com" "$EXPORT"
# A credential is not "data about the person": exporting it only creates another way to leak.
check "no password hash in the file"                   "0"                  "$(printf '%s' "$EXPORT" | grep -ciE '\$2[aby]\$|scrypt|"password"')"
check "no 2FA secret or codes"                         "0"                  "$(printf '%s' "$EXPORT" | grep -ciE '"secret"|"backupCodes"')"
check "someone without a session exports nothing"      "401"                "$(get /api/account/export)"

# The only owner of a workspace WITH other members: deleting would take
# everyone's work along, so it blocks and asks for a transfer.
WS_VIEWER="$(sql "SELECT m.organizationId AS id FROM member m JOIN user u ON u.id=m.userId WHERE u.email='leitor@exemplo.com'" | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["id"])')"
sql "INSERT INTO member (id,organizationId,userId,role,createdAt) VALUES ('m_extra','$WS_VIEWER','$(id_of admin@exemplo.com)','editor',unixepoch())" >/dev/null
check "the only owner of a shared workspace is blocked"    "e=last_owner" "$(post "$LGPD" /api/account/delete confirmation=leitor@exemplo.com password=senha-final-do-leitor)"
sql "DELETE FROM member WHERE id='m_extra'" >/dev/null

check "deleting with the wrong confirmation e-mail"    "e=confirm_email" "$(post "$LGPD" /api/account/delete confirmation=errado@exemplo.com password=senha-final-do-leitor)"
# The workspaces go before the account, so the password is checked before
# anything is touched: a wrong one used to wipe them and leave the account.
OWNED="$(sql "SELECT COUNT(*) AS n FROM member WHERE userId='$(id_of leitor@exemplo.com)' AND role='owner'")"
check "deleting with the wrong password"               "e=current_password"       "$(post "$LGPD" /api/account/delete confirmation=leitor@exemplo.com password=chute-errado)"
check "and the wrong password destroyed nothing"       "$OWNED"                   "$(sql "SELECT COUNT(*) AS n FROM member WHERE userId='$(id_of leitor@exemplo.com)' AND role='owner'")"
check "deleting with everything right"                 "ok=ok_account_deleted" "$(post "$LGPD" /api/account/delete confirmation=leitor@exemplo.com password=senha-final-do-leitor)"
check "the account is gone from the database"          "[]"                  "$(sql "SELECT id FROM user WHERE email='leitor@exemplo.com'")"
# The workspace with the time entries above was theirs alone by now, and went with the account.
check "the project sums went with the account and its workspaces"  '"missing": 0, "extra": 0, "kept": 0'  "$(totals_state)"
check "the audit trail became dissociated"             "account removed"      "$(sql "SELECT actorEmail FROM audit_log WHERE actorEmail='[account removed]' LIMIT 1")"
check "and none of their IPs was left in the trail"    "[]"                  "$(sql "SELECT ip FROM audit_log WHERE targetEmail='[account removed]' AND actorEmail IS NULL AND ip IS NOT NULL")"

echo; echo "$(c 1 'Error pages')"
check "404 uses the system page, not the raw one"      "not found"      "$(curl -s -b "$ADMIN" "$BASE/dashboard/route-that-does-not-exist" | grep -oE 'Page not found' | head -1)"
check "/privacy opens without a session"           "200"                 "$(get /privacy)"

echo; echo "$(c 1 'Rate limit (5/min on login)')"
npx wrangler d1 execute "$DB" --local -c "$CFG" --command 'DELETE FROM "rateLimit";' >/dev/null 2>&1
LIMITED=""
for i in 1 2 3 4 5 6 7; do
  [[ "$(post - /api/login email=alvo@exemplo.com "password=chute-numero-$i")" == *"e=rate_limit"* ]] && { LIMITED="$i"; break; }
done
check "login locks after a few attempts"               "trava"  "${LIMITED:+trava na tentativa $LIMITED}"

echo; echo "$(c 1 'Audit')"
check "first admin creation recorded"                  "setup.first_admin"  "$(sql "SELECT action FROM audit_log WHERE action='setup.first_admin'")"
check "workspace creation recorded"                    "workspace.created"  "$(sql "SELECT action FROM audit_log WHERE action='workspace.created'")"
check "password change recorded"                       "self.password_changed" "$(sql "SELECT action FROM audit_log WHERE action='self.password_changed'")"
check "2FA activation recorded"                        "self.2fa_enabled"      "$(sql "SELECT action FROM audit_log WHERE action='self.2fa_enabled'")"
check "session revocation recorded"                    "user.sessions_revoked" "$(sql "SELECT action FROM audit_log WHERE action='user.sessions_revoked'")"
check "account disabling recorded"                     "user.disabled"         "$(sql "SELECT action FROM audit_log WHERE action='user.disabled'")"

echo
rm -rf "$TMP"
printf "%s  %d passed, %d failed\n" "$([[ $FAIL -eq 0 ]] && c 32 ●  || c 31 ●)" "$PASS" "$FAIL"
exit $(( FAIL > 0 ? 1 : 0 ))
