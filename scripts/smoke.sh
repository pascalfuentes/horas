#!/usr/bin/env bash
# Bateria de fumaça: exercita os fluxos e os invariantes contra o servidor de
# desenvolvimento. Não substitui testes unitários — prova que o caminho completo
# (HTTP → Better Auth → D1 → triggers) está de pé.
#
#   1. npm run dev          (em outro terminal)
#   2. ./scripts/smoke.sh
#
# RECRIA o banco LOCAL do zero. Nunca aponte para produção.
set -uo pipefail

BASE="${BASE:-http://localhost:4321}"
# Nome do banco e caminho da config vêm da mesma fonte que o resto dos scripts,
# senão a bateria consulta um banco e o servidor usa outro.
CFG="$(node -e "import('./scripts/config.mjs').then(m=>process.stdout.write(m.configPath()))")"
DB="${DB:-$(node -e "import('./scripts/config.mjs').then(m=>process.stdout.write(String(m.readConfig().databaseName)))")}"
TMP="$(mktemp -d)"
ADMIN="$TMP/admin.txt"
LEITOR="$TMP/leitor.txt"
PASS=0; FAIL=0

c() { printf '\033[%sm%s\033[0m' "$1" "$2"; }
check() { # check <descrição> <esperado> <obtido>
  if [[ "$3" == *"$2"* ]]; then
    printf "  %s %s\n" "$(c 32 '✓')" "$1"; PASS=$((PASS+1))
  else
    printf "  %s %s\n      esperava conter: %s\n      obteve:          %s\n" "$(c 31 '✗')" "$1" "$2" "${3:-<vazio>}"; FAIL=$((FAIL+1))
  fi
}
post() { # post <jar|-> <caminho> <campo=valor...>
  local jar="$1" path="$2"; shift 2
  local args=(-s -o /dev/null -w '%{http_code} %{redirect_url}' -X POST "$BASE$path" -H "Origin: $BASE")
  [[ "$jar" != "-" ]] && args+=(-b "$jar" -c "$jar")
  local f; for f in "$@"; do args+=(--data-urlencode "$f"); done
  curl "${args[@]}"
}
get() { curl -s -o /dev/null -w '%{http_code} %{redirect_url}' ${2:+-b "$2"} "$BASE$1"; }
tem() { # tem <caminho> <jar> <texto> — "sim" se a página contém o texto
  if curl -s -b "$2" "$BASE$1" | grep -qF "$3"; then echo sim; else echo nao; fi
}
sql() { npx wrangler d1 execute "$DB" --local -c "$CFG" --json --command "$1" 2>/dev/null \
        | python3 -c 'import sys,json;print(json.dumps(json.load(sys.stdin)[0]["results"]))'; }
sql_err() { npx wrangler d1 execute "$DB" --local -c "$CFG" --command "$1" 2>&1 | sed $'s/\033\\[[0-9;]*m//g'; }
# Ativa o 2FA de uma conta: inicia a configuração, extrai o segredo TOTP e os
# códigos de recuperação da página, e confirma com um código de verdade.
# Preenche SEGREDO_2FA e CODIGOS_2FA.
ativar_2fa() { # ativar_2fa <jar> <senha>
  local jar="$1" password="$2"
  HTML_2FA="$(curl -s -b "$jar" -c "$jar" -X POST "$BASE/dashboard/security/2fa" \
              -H "Origin: $BASE" --data-urlencode "password=$password")"
  local html="$HTML_2FA"
  SEGREDO_2FA="$(printf '%s' "$html" | grep -oE '<code>[A-Z2-7]{16,}</code>' | head -1 | sed 's/<[^>]*>//g')"
  CODIGOS_2FA="$(printf '%s' "$html" | python3 -c "
import re, sys
m = re.search(r'<pre[^>]*>(.*?)</pre>', sys.stdin.read(), re.S)
print('\n'.join(l.strip() for l in m.group(1).split('\n') if l.strip()) if m else '')")"
  [[ -z "$SEGREDO_2FA" ]] && return 1
  post "$jar" /api/security/2fa action=confirm "code=$(node scripts/totp.mjs "$SEGREDO_2FA")" >/dev/null
}
codigo_totp() { node scripts/totp.mjs "$SEGREDO_2FA"; }
zerar_limite() { npx wrangler d1 execute "$DB" --local -c "$CFG" --command 'DELETE FROM "rateLimit";' >/dev/null 2>&1; }
# Cria uma conta pelo cadastro aberto e a deixa pronta para entrar.
#
# O `emailVerified` é ligado em SQL de propósito: o token de verificação é um
# JWT assinado, não uma linha no banco, então não há como lê-lo de forma
# determinística daqui. O PORTÃO (login barrado antes de verificar) é testado
# à parte, que é a propriedade de segurança que importa.
criar_conta() { # criar_conta <jar|-> <nome> <email> <senha>
  post - /api/signup "name=$2" "email=$3" "password=$4" "confirm=$4" >/dev/null
  sql "UPDATE user SET emailVerified = 1 WHERE email = '$3'" >/dev/null
  zerar_limite
  [[ "$1" != "-" ]] && post "$1" /api/login "email=$3" "password=$4" >/dev/null
  return 0
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then printf '%s' "$1" | sha256sum | cut -d' ' -f1
  else printf '%s' "$1" | shasum -a 256 | cut -d' ' -f1; fi
}
convite_id() { # convite_id <email> — o convite pendente mais recente para esse e-mail
  sql "SELECT id FROM org_invitation WHERE email='$1' AND status='pending' ORDER BY createdAt DESC LIMIT 1" \
    | python3 -c 'import sys,json;r=json.load(sys.stdin);print(r[0]["id"] if r else "")'
}
member_id() { # member_id <email> <slug>
  sql "SELECT m.id FROM member m JOIN user u ON u.id=m.userId JOIN organization o ON o.id=m.organizationId WHERE u.email='$1' AND o.slug='$2'" \
    | python3 -c 'import sys,json;r=json.load(sys.stdin);print(r[0]["id"] if r else "")'
}
papel_de() { # papel_de <email> <slug>
  sql "SELECT m.role FROM member m JOIN user u ON u.id=m.userId JOIN organization o ON o.id=m.organizationId WHERE u.email='$1' AND o.slug='$2'"
}
slug_de() { # slug_de <email> — o workspace pessoal da pessoa
  sql "SELECT o.slug FROM organization o JOIN member m ON m.organizationId=o.id JOIN user u ON u.id=m.userId WHERE u.email='$1' LIMIT 1" \
    | python3 -c 'import sys,json;r=json.load(sys.stdin);print(r[0]["slug"] if r else "")'
}
papel_no_ws() { # papel_no_ws <email> <slug> <papel>
  sql "UPDATE member SET role='$3' WHERE userId=(SELECT id FROM user WHERE email='$1') AND organizationId=(SELECT id FROM organization WHERE slug='$2')" >/dev/null
}
id_de() { sql "SELECT id FROM user WHERE email='$1'" | python3 -c 'import sys,json;r=json.load(sys.stdin);print(r[0]["id"] if r else "")'; }
# Apagar o arquivo do D1 não serve: o servidor de dev continua com o handle
# antigo aberto e os dois passam a ver bancos diferentes. E o trigger de último
# admin impede o DELETE. Então derrubamos os triggers, limpamos e recriamos os
# triggers a partir da própria migration.
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

command -v python3 >/dev/null || { echo "python3 é necessário"; exit 1; }
SECRET="$(grep -E '^SETUP_SECRET=' .dev.vars 2>/dev/null | cut -d'"' -f2)"
[[ -z "${SECRET:-}" ]] && { echo "SETUP_SECRET não encontrada em .dev.vars"; exit 1; }

# Sem isto, um servidor fora do ar vira 40 falhas vermelhas que não dizem nada.
STATUS="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/login" 2>/dev/null || echo 000)"
if [[ "$STATUS" != "200" ]]; then
  echo
  echo "$(c 31 '✗') O servidor não respondeu em $BASE (HTTP ${STATUS})."
  echo
  echo "  Suba com \`npm run dev\` noutro terminal e rode de novo."
  echo "  Se ele já estava rodando, reinicie: \`npx astro dev stop && npm run dev\`"
  echo "  — rodar \`npm run build\` com o dev server no ar costuma derrubá-lo."
  echo
  exit 1
fi

echo "Recriando o banco local…"; reset_db

echo; echo "$(c 1 'Bootstrap do primeiro administrador')"
check "/ vai para /setup com o banco vazio"            "/setup"           "$(get /)"
check "/dashboard sem sessão vai para /login"          "/login?next"      "$(get /dashboard)"
check "setup com secret errado é recusado"             "e=no_permission"  "$(post - /api/setup secret=errado name=X email=x@y.com password=senha-longa-o-suficiente confirm=senha-longa-o-suficiente)"
check "setup com secret correto cria o admin"          "/dashboard"       "$(post "$ADMIN" /api/setup "secret=$SECRET" "name=Admin Teste" email=admin@exemplo.com password=senha-longa-o-suficiente confirm=senha-longa-o-suficiente)"
check "primeiro usuário nasceu com role=admin"         '"role": "admin"'  "$(sql "SELECT role FROM user WHERE email='admin@exemplo.com'")"
check "/setup morre depois do primeiro usuário"        "/login"           "$(get /setup)"
check "o admin entra, e é levado a configurar o 2FA"    "/dashboard/security/2fa"  "$(get /dashboard "$ADMIN")"

echo; echo "$(c 1 'Verificação em duas etapas (obrigatória para admin)')"
ativar_2fa "$ADMIN" senha-longa-o-suficiente
check "a configuração devolve um segredo TOTP"         "ok"                        "${SEGREDO_2FA:+ok}"
check "e dez códigos de recuperação"                   "10"                        "$(printf '%s\n' "$CODIGOS_2FA" | grep -c .)"
# O gerador de QR emite o SVG só com viewBox. Num container `width: max-content`
# isso colapsa para 0×0: o QR existia no HTML e não aparecia na tela. Conferir
# que existe um <svg> não bastava — o que importa é ele ter tamanho.
check "o QR tem tamanho explícito (não 0x0)"           'width="220"'               "$(printf '%s' "$HTML_2FA" | grep -oE '<svg[^>]*' | head -1)"
check "confirmar liga o 2FA"                           '"twoFactorEnabled": 1'     "$(sql "SELECT twoFactorEnabled FROM user WHERE email='admin@exemplo.com'")"
check "admin volta a navegar livremente"               "200"                       "$(get /dashboard/admin/users "$ADMIN")"

npx wrangler d1 execute "$DB" --local -c "$CFG" --command 'DELETE FROM "rateLimit";' >/dev/null 2>&1
DOISF="$TMP/2fa.txt"
check "login com senha certa pede o segundo fator"     "/two-factor"     "$(post "$DOISF" /api/login email=admin@exemplo.com password=senha-longa-o-suficiente)"
check "o cookie temporário NÃO abre o dashboard"       "/login?next"       "$(get /dashboard "$DOISF")"
check "código errado é recusado"                       "e=invalid_code" "$(post "$DOISF" /api/two-factor action=totp code=000000)"
check "código correto entra"                           "/dashboard"        "$(post "$DOISF" /api/two-factor action=totp "code=$(codigo_totp)")"

npx wrangler d1 execute "$DB" --local -c "$CFG" --command 'DELETE FROM "rateLimit";' >/dev/null 2>&1
RECUP="$TMP/recup.txt"
BACKUP1="$(printf '%s\n' "$CODIGOS_2FA" | sed -n 1p)"
post "$RECUP" /api/login email=admin@exemplo.com password=senha-longa-o-suficiente >/dev/null
check "código de recuperação entra"                    "/dashboard"        "$(post "$RECUP" /api/two-factor action=backup "code=$BACKUP1")"
npx wrangler d1 execute "$DB" --local -c "$CFG" --command 'DELETE FROM "rateLimit";' >/dev/null 2>&1
post "$RECUP" /api/login email=admin@exemplo.com password=senha-longa-o-suficiente >/dev/null
check "o mesmo código de recuperação não serve 2x"     "e=invalid_code" "$(post "$RECUP" /api/two-factor action=backup "code=$BACKUP1")"

# Sem esta ação, quem perde o celular E os códigos fica trancado para sempre.
ADMIN_ID="$(id_de admin@exemplo.com)"
check "admin destrava o 2FA de alguém"                 "ok=ok_2fa_reset" "$(post "$ADMIN" /api/admin/users action=reset-2fa "userId=$ADMIN_ID" email=admin@exemplo.com)"
check "e o 2FA some do banco"                          '"twoFactorEnabled": 0' "$(sql "SELECT twoFactorEnabled FROM user WHERE email='admin@exemplo.com'")"
# A sessão do admin caiu junto (as sessões foram revogadas), então entra de novo
# e reativa o 2FA para o resto da bateria continuar.
zerar_limite
post "$ADMIN" /api/login email=admin@exemplo.com password=senha-longa-o-suficiente >/dev/null
ativar_2fa "$ADMIN" senha-longa-o-suficiente
check "e dá para configurar de novo em seguida"        '"twoFactorEnabled": 1' "$(sql "SELECT twoFactorEnabled FROM user WHERE email='admin@exemplo.com'")"

echo; echo "$(c 1 'Invariantes de workspace (no BANCO)')"
ADMIN_ID="$(id_de admin@exemplo.com)"
WS_ADMIN="$(sql "SELECT m.organizationId AS id FROM member m WHERE m.userId='$ADMIN_ID'" | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["id"])')"
check "rebaixar o único owner aborta"                  "LAST_OWNER"       "$(sql_err "UPDATE member SET role='editor' WHERE organizationId='$WS_ADMIN'")"
check "remover o único owner aborta"                   "LAST_OWNER"       "$(sql_err "DELETE FROM member WHERE organizationId='$WS_ADMIN'")"
check "o owner segue de pé"                            '"role": "owner"'  "$(sql "SELECT role FROM member WHERE organizationId='$WS_ADMIN'")"
check "papel de plataforma inventado é recusado"       "PAPEL_PLATAFORMA" "$(sql_err "UPDATE user SET role='readonly' WHERE email='admin@exemplo.com'")"

# Workspace descartável, sem membros ainda: dá para exercitar o validador de
# papel sem esbarrar no trigger de último owner, que no owner dispara primeiro.
sql "INSERT INTO organization (id,name,slug,createdAt) VALUES ('ws_descartavel','Descartável','descartavel',unixepoch())" >/dev/null
check "papel de workspace inventado é recusado"        "PAPEL_INVALIDO"   "$(sql_err "INSERT INTO member (id,organizationId,userId,role,createdAt) VALUES ('m_x','ws_descartavel','$ADMIN_ID','chefe',unixepoch())")"
check "papel com vírgula é recusado"                   "PAPEL_INVALIDO"   "$(sql_err "INSERT INTO member (id,organizationId,userId,role,createdAt) VALUES ('m_y','ws_descartavel','$ADMIN_ID','owner,admin',unixepoch())")"

# A prova de que o guarda `EXISTS(... organization ...)` no trigger de último
# owner funciona: sem ele o cascade dispara LAST_OWNER e apagar um workspace
# fica IMPOSSÍVEL. Este check é o que impede essa regressão silenciosa.
sql "INSERT INTO member (id,organizationId,userId,role,createdAt) VALUES ('m_desc','ws_descartavel','$ADMIN_ID','owner',unixepoch())" >/dev/null
sql_err "DELETE FROM organization WHERE id='ws_descartavel'" >/dev/null
check "apagar um workspace inteiro FUNCIONA"           "[]"               "$(sql "SELECT id FROM organization WHERE id='ws_descartavel'")"
check "e leva as memberships junto"                    "[]"               "$(sql "SELECT id FROM member WHERE organizationId='ws_descartavel'")"

echo; echo "$(c 1 'Invariante do último administrador (no BANCO)')"
check "rebaixar o único admin aborta"                  "LAST_ADMIN"       "$(sql_err "UPDATE user SET role='user' WHERE email='admin@exemplo.com'")"
check "banir o único admin aborta"                     "LAST_ADMIN"       "$(sql_err "UPDATE user SET banned=1 WHERE email='admin@exemplo.com'")"
check "apagar o único admin aborta"                    "LAST_ADMIN"       "$(sql_err "DELETE FROM user WHERE email='admin@exemplo.com'")"
check "o admin segue de pé"                            '"role": "admin"'  "$(sql "SELECT role FROM user WHERE email='admin@exemplo.com'")"

echo; echo "$(c 1 'Cadastro aberto e workspace pessoal')"
check "o superadmin ganhou workspace pessoal"          '"role": "owner"'      "$(sql "SELECT m.role FROM member m JOIN user u ON u.id=m.userId WHERE u.email='admin@exemplo.com'")"
check "e a sessão dele já tem workspace ativo"         '"tem": 1'             "$(sql "SELECT COUNT(*) AS tem FROM session WHERE activeOrganizationId IS NOT NULL")"

post - /api/signup name=Leitor email=leitor@exemplo.com password=outra-senha-bem-longa confirm=outra-senha-bem-longa >/dev/null
check "cadastro aberto cria a conta"                   "leitor@exemplo.com"   "$(sql "SELECT email FROM user WHERE email='leitor@exemplo.com'")"
check "com o e-mail AINDA não verificado"              '"emailVerified": 0'   "$(sql "SELECT emailVerified FROM user WHERE email='leitor@exemplo.com'")"
check "e com workspace pessoal, como owner"            '"role": "owner"'      "$(sql "SELECT m.role FROM member m JOIN user u ON u.id=m.userId WHERE u.email='leitor@exemplo.com'")"
# Sem isto, cadastro aberto deixaria qualquer pessoa entrar com o e-mail alheio.
zerar_limite
check "login é BARRADO antes de verificar o e-mail"    "e=email_not_verified" "$(post - /api/login email=leitor@exemplo.com password=outra-senha-bem-longa)"

# Cadastrar com e-mail que já existe não can revelar que ele existe.
check "e-mail já cadastrado responde IGUAL a um novo"  "ok=ok_signup"       "$(post - /api/signup name=Impostor email=leitor@exemplo.com password=mais-uma-senha-longa confirm=mais-uma-senha-longa)"
check "e nenhuma conta duplicada foi criada"           '"n": 1'               "$(sql "SELECT COUNT(*) AS n FROM user WHERE email='leitor@exemplo.com'")"
check "reenviar verificação responde igual p/ inexistente" "ok=ok_verification_resent" "$(post - /api/resend-verification email=ninguem@exemplo.com)"

# O Turnstile é validado no ENDPOINT, não só na nossa página: um POST direto em
# /api/auth/sign-up/email criava conta sem desafio nenhum, e a proteção
# anti-bot valia só para quem usasse o formulário. Este check só roda onde há
# chave configurada — sem ela o hook não tem o que validar.
if curl -s "$BASE/signup" | grep -q 'cf-turnstile'; then
  check "sign-up direto exige Turnstile"               "400"  "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/auth/sign-up/email" -H "Origin: $BASE" -H 'Content-Type: application/json' -d '{"name":"X","email":"robo@exemplo.com","password":"senha-longa-o-suficiente"}')"
  check "e nenhuma conta foi criada por ele"           "[]"   "$(sql "SELECT id FROM user WHERE email='robo@exemplo.com'")"
fi

sql "UPDATE user SET emailVerified = 1 WHERE email = 'leitor@exemplo.com'" >/dev/null
zerar_limite
check "verificado, o login passa"                      "/dashboard"           "$(post "$LEITOR" /api/login email=leitor@exemplo.com password=outra-senha-bem-longa)"
check "cada pessoa tem o SEU workspace"                '"n": 2'               "$(sql "SELECT COUNT(*) AS n FROM organization")"

echo; echo "$(c 1 'Workspace na URL e isolamento')"
WS_ADMIN_SLUG="$(slug_de admin@exemplo.com)"
WS_LEITOR_SLUG="$(slug_de leitor@exemplo.com)"
check "/dashboard leva ao último workspace usado"      "/w/"              "$(get /dashboard "$ADMIN")"
check "o dono abre o próprio workspace"                "200"              "$(get "/w/$WS_ADMIN_SLUG" "$ADMIN")"
check "e as anotações dele"                            "200"              "$(get "/w/$WS_ADMIN_SLUG/notes" "$ADMIN")"

# 404 e não 403: "sem permissão" confirmaria que o workspace existe, o que é
# informação de graça para quem estiver sondando slugs.
check "workspace alheio responde 404, não 403"         "404"              "$(get "/w/$WS_ADMIN_SLUG" "$LEITOR")"
check "e as anotações dele também"                     "404"              "$(get "/w/$WS_ADMIN_SLUG/notes" "$LEITOR")"
check "a API de workspace alheio também é 404"         "404"              "$(post "$LEITOR" "/api/w/$WS_ADMIN_SLUG/notes" title=invasao)"
check "workspace que não existe também é 404"          "404"              "$(get "/w/isso-nao-existe" "$ADMIN")"

# Conteúdo tem que ficar dentro do workspace onde foi criado.
post "$LEITOR" "/api/w/$WS_LEITOR_SLUG/notes" title=NotaDoLeitor >/dev/null
check "nota criada num workspace fica só nele"         '"n": 1'           "$(sql "SELECT COUNT(*) AS n FROM note n JOIN organization o ON o.id=n.workspaceId WHERE o.slug='$WS_LEITOR_SLUG'")"
check "e não aparece no workspace do outro"            "[]"               "$(sql "SELECT n.title FROM note n JOIN organization o ON o.id=n.workspaceId WHERE o.slug='$WS_ADMIN_SLUG' AND n.title='NotaDoLeitor'")"

echo; echo "$(c 1 'Papéis dentro do workspace')"
# O leitor é owner do workspace dele; rebaixar exige outro owner, então o teste
# usa um workspace onde ele NÃO é o único dono.
sql "INSERT INTO member (id,organizationId,userId,role,createdAt) VALUES ('m_teste',(SELECT id FROM organization WHERE slug='$WS_ADMIN_SLUG'),(SELECT id FROM user WHERE email='leitor@exemplo.com'),'viewer',unixepoch())" >/dev/null
check "agora ele enxerga o workspace do admin"         "200"              "$(get "/w/$WS_ADMIN_SLUG" "$LEITOR")"
check "mas como viewer leva 403 ao escrever"           "403"              "$(post "$LEITOR" "/api/w/$WS_ADMIN_SLUG/notes" title=nao-deveria-passar)"
papel_no_ws leitor@exemplo.com "$WS_ADMIN_SLUG" editor
check "promovido a editor, consegue escrever"          "ok=ok_note"       "$(post "$LEITOR" "/api/w/$WS_ADMIN_SLUG/notes" title=AgoraVai)"
sql "DELETE FROM member WHERE id='m_teste'" >/dev/null

echo; echo "$(c 1 'Convites de workspace')"
# Workspace próprio para estes testes: transferir e sair deixariam o admin sem
# workspace nenhum, e o resto da bateria conta com o pessoal dele intacto.
post "$ADMIN" /api/workspaces name="Time de Teste" >/dev/null
WS="$(sql "SELECT slug FROM organization WHERE name='Time de Teste'" | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["slug"])')"
check "criar workspace funciona"                       "200"                   "$(get "/w/$WS" "$ADMIN")"
check "admin convida alguém como editor"               "ok=ok_invite_sent" "$(post "$ADMIN" "/api/w/$WS/invites" action=invite email=leitor@exemplo.com role=editor)"
check "convidar de novo é barrado"                     "e=invite_pending"    "$(post "$ADMIN" "/api/w/$WS/invites" action=invite email=leitor@exemplo.com role=editor)"
check "convidar para owner é recusado"                 "e=invalid_role"      "$(post "$ADMIN" "/api/w/$WS/invites" action=invite email=outra@exemplo.com role=owner)"
check "papel inventado é recusado"                     "e=invalid_role"      "$(post "$ADMIN" "/api/w/$WS/invites" action=invite email=outra@exemplo.com role=chefe)"

CONVITE="$(convite_id leitor@exemplo.com)"
check "o convite ficou pendente no banco"              "pending"              "${CONVITE:+pending}"
check "a página do convite é pública"                  "200"                   "$(get "/invite/$CONVITE")"

# O aviso no painel. Sem ele, o único caminho até um convite é o link do e-mail
# — e quem apagou a mensagem fica sem saída, mesmo já estando logado.
check "o convidado vê o aviso no painel"               "sim"                   "$(tem /dashboard/profile "$LEITOR" "convite esperando")"
check "e o aviso nomeia o workspace"                   "sim"                   "$(tem /dashboard/profile "$LEITOR" "Time de Teste")"
check "quem não foi convidado não vê aviso nenhum"     "nao"                   "$(tem /dashboard/profile "$ADMIN" "convite esperando")"

# A trava central: o convite é do e-mail que o recebeu, e de mais ninguém.
check "aceitar com a conta ERRADA é recusado"          "e=not_recipient"  "$(post "$ADMIN" /api/invite/accept "id=$CONVITE")"
check "e ninguém entrou no workspace por isso"         '"n": 1'                "$(sql "SELECT COUNT(*) AS n FROM member m JOIN organization o ON o.id=m.organizationId WHERE o.slug='$WS'")"

check "aceitar com a conta certa funciona"             "ok=ok_invite_accepted"  "$(post "$LEITOR" /api/invite/accept "id=$CONVITE")"
check "e o papel veio do CONVITE"                      '"role": "editor"'      "$(papel_de leitor@exemplo.com "$WS")"
check "agora ele abre o workspace"                     "200"                   "$(get "/w/$WS" "$LEITOR")"
check "e consegue escrever, como editor"               "ok=ok_note"            "$(post "$LEITOR" "/api/w/$WS/notes" title=DoEditor)"
check "mas editor NÃO convida ninguém"                 "403"                   "$(post "$LEITOR" "/api/w/$WS/invites" action=invite email=x@y.com role=viewer)"

check "o aviso some depois de aceitar"                 "nao"                   "$(tem /dashboard/profile "$LEITOR" "convite esperando")"
# O plugin marca como ativo o workspace recém-aceito, então /dashboard leva
# para dentro dele em vez de devolver para o workspace pessoal.
check "e o painel já cai dentro do workspace aceito"   "/w/$WS"                "$(get /dashboard "$LEITOR")"
check "e a confirmação sobrevive ao salto"             "ok=ok_invite_accepted"  "$(get "/dashboard?ok=ok_invite_accepted" "$LEITOR")"
check "mas query estranho não entra de carona"         "/w/$WS/time?ok="      "$(get "/dashboard?lixo=abc&ok=ok_invite_accepted" "$LEITOR")"

# A trava do aviso é o e-mail: convite de terceiro não can aparecer para mim.
post "$ADMIN" "/api/w/$WS/invites" action=invite email=ninguem@exemplo.com role=viewer >/dev/null
check "convite endereçado a OUTRA pessoa não vaza"     "nao"                   "$(tem /dashboard/profile "$LEITOR" "convite esperando")"

echo; echo "$(c 1 'Gestão de membros')"
ID_LEITOR="$(member_id leitor@exemplo.com "$WS")"
ID_ADMIN="$(member_id admin@exemplo.com "$WS")"
check "admin rebaixa o editor para viewer"             "ok=ok_member_role"    "$(post "$ADMIN" "/api/w/$WS/members" action=role "memberId=$ID_LEITOR" role=viewer)"
check "como viewer, escrever leva 403"                 "403"                   "$(post "$LEITOR" "/api/w/$WS/notes" title=nao-deveria)"
check "ninguém muda o próprio papel"                   "e=own_membership"      "$(post "$ADMIN" "/api/w/$WS/members" action=role "memberId=$ID_ADMIN" role=viewer)"
check "e ninguém vira owner por troca de papel"        "e=invalid_role"      "$(post "$ADMIN" "/api/w/$WS/members" action=role "memberId=$ID_LEITOR" role=owner)"

# Transferência: promove primeiro, rebaixa depois. Na ordem inversa o trigger
# abortaria, porque o workspace ficaria sem dono no meio do caminho.
check "owner transfere a propriedade"                  "ok=ok_transferred"     "$(post "$ADMIN" "/api/w/$WS/members" action=transfer "memberId=$ID_LEITOR" "myMemberId=$ID_ADMIN")"
check "quem recebeu virou owner"                       '"role": "owner"'       "$(papel_de leitor@exemplo.com "$WS")"
check "quem transferiu virou admin"                    '"role": "admin"'       "$(papel_de admin@exemplo.com "$WS")"
check "e o workspace segue com um dono só"             '"n": 1'                "$(sql "SELECT COUNT(*) AS n FROM member m JOIN organization o ON o.id=m.organizationId WHERE o.slug='$WS' AND m.role='owner'")"

check "agora o ex-dono consegue sair"                  "ok=ok_left"            "$(post "$ADMIN" "/api/w/$WS/members" action=leave)"
check "e perde o acesso na hora"                       "404"                   "$(get "/w/$WS" "$ADMIN")"

# Dono único do próprio workspace pessoal não can sair: ele ficaria órfão.
# Quem garante isso é o trigger, não a aplicação.
WS_LEITOR="$(slug_de leitor@exemplo.com)"
check "último dono não consegue sair"                  "e="                    "$(post "$LEITOR" "/api/w/$WS_LEITOR/members" action=leave)"
check "e continua sendo dono"                          '"role": "owner"'       "$(papel_de leitor@exemplo.com "$WS_LEITOR")"

echo; echo "$(c 1 'Autorização de plataforma')"
ADMIN_ID="$(id_de admin@exemplo.com)"
check "usuário comum leva 403 em /api/admin/users"  "403"              "$(post "$LEITOR" /api/admin/users action=role userId=x role=admin)"
check "e é desviado de /dashboard/admin"               "e=no_permission"  "$(get /dashboard/admin/users "$LEITOR")"
check "mas TROCA a própria senha (account:write)"      "ok=ok_password"      "$(post "$LEITOR" /api/security/password current_password=outra-senha-bem-longa new_password=senha-nova-do-leitor confirm=senha-nova-do-leitor)"
check "admin cria nota no workspace dele"              "ok=ok_note"       "$(post "$ADMIN" "/api/w/$(slug_de admin@exemplo.com)/notes" title=Nota "body=do admin")"
check "admin não muda o próprio papel"                 "e=own_role"  "$(post "$ADMIN" /api/admin/users action=role "userId=$ADMIN_ID" role=user)"
check "admin não desativa a própria conta"             "e=own_status" "$(post "$ADMIN" /api/admin/users action=disable "userId=$ADMIN_ID")"

echo; echo "$(c 1 'Arquivos estáticos não passam pelo portão de login')"
check "arquivo inexistente dá 404, não redirect"      "404"              "$(get /favicon.ico)"
check "outro arquivo inexistente também"              "404"              "$(get /nao-existe.txt)"
check "o favicon do projeto é servido"                "200"              "$(get /favicon.svg)"
check "mas /dashboard/*.json ainda exige sessão"      "/login?next"      "$(get /dashboard/relatorio.json)"

echo; echo "$(c 1 'Credenciais e anti-enumeração')"
npx wrangler d1 execute "$DB" --local -c "$CFG" --command 'DELETE FROM "rateLimit";' >/dev/null 2>&1
check "senha nova funciona"                            "/dashboard"     "$(post - /api/login email=leitor@exemplo.com password=senha-nova-do-leitor)"
check "senha antiga não funciona mais"                 "e=credentials"  "$(post - /api/login email=leitor@exemplo.com password=outra-senha-bem-longa)"
check "e-mail inexistente dá a MESMA mensagem"         "e=credentials"  "$(post - /api/login email=ninguem@exemplo.com password=qualquer-coisa-longa)"
check "esqueci-senha: inexistente responde sucesso"    "ok=ok_reset"    "$(post - /api/forgot-password email=ninguem@exemplo.com)"
check "esqueci-senha: e-mail real responde igual"      "ok=ok_reset"    "$(post - /api/forgot-password email=admin@exemplo.com)"

echo; echo "$(c 1 'Login social')"
# Os provedores só existem quando o par de chaves está configurado, então a
# bateria checa o comportamento correto para o ambiente em que está rodando.
if curl -s "$BASE/login" | grep -q 'api/social'; then
  check "Google inicia o fluxo OAuth"                  "accounts.google.com"    "$(curl -s -o /dev/null -D - -X POST "$BASE/api/social" -H "Origin: $BASE" --data-urlencode provider=google | grep -i '^location:')"
  check "e o cookie de state/PKCE vai junto"           "set-cookie"             "$(curl -s -o /dev/null -D - -X POST "$BASE/api/social" -H "Origin: $BASE" --data-urlencode provider=google | grep -io '^set-cookie' | head -1)"
else
  check "sem chaves, os botões sociais não aparecem"   "0"                      "$(curl -s "$BASE/login" | grep -c 'api/social')"
  check "sem chaves, a rota social recusa"             "e=social_unavailable"  "$(post - /api/social provider=google)"
fi
check "provedor desconhecido é recusado"               "e=social_unavailable"  "$(post - /api/social provider=facebook)"

echo; echo "$(c 1 'Controles de segurança')"

# --- ciclo completo de recuperação de senha ---
zerar_limite
sql "DELETE FROM verification" >/dev/null
post - /api/forgot-password email=leitor@exemplo.com >/dev/null
TOKEN_RESET="$(sql "SELECT identifier FROM verification WHERE identifier LIKE 'reset-password:%'" \
  | python3 -c "import sys,json;r=json.load(sys.stdin);print(r[0]['identifier'].split(':',1)[1] if r else '')")"
check "o pedido de recuperação gera um token"         "ok"             "${TOKEN_RESET:+ok}"
check "redefinir com o token funciona"                "ok=ok_password"    "$(post - /api/reset-password "token=$TOKEN_RESET" password=senha-redefinida-aqui confirm=senha-redefinida-aqui)"
zerar_limite
check "a senha nova entra"                            "/dashboard"     "$(post - /api/login email=leitor@exemplo.com password=senha-redefinida-aqui)"
check "a senha anterior morreu"                       "e=credentials"  "$(post - /api/login email=leitor@exemplo.com password=senha-nova-do-leitor)"
check "o mesmo token de recuperação não serve 2x"     "e="             "$(post - /api/reset-password "token=$TOKEN_RESET" password=outra-senha-qualquer confirm=outra-senha-qualquer)"

# --- revogar sessões precisa derrubar de verdade, não só limpar a tabela ---
zerar_limite
VIVA="$TMP/viva.txt"
post "$VIVA" /api/login email=leitor@exemplo.com password=senha-redefinida-aqui >/dev/null
check "a sessão recém-criada funciona"                "/w/"            "$(get /dashboard "$VIVA")"
post "$ADMIN" /api/admin/users action=revoke-sessions "userId=$(id_de leitor@exemplo.com)" email=leitor@exemplo.com >/dev/null
check "admin revoga e a sessão morre na hora"         "/login?next"    "$(get /dashboard "$VIVA")"

# --- conta desativada perde o acesso ---
zerar_limite
post "$ADMIN" /api/admin/users action=disable "userId=$(id_de leitor@exemplo.com)" email=leitor@exemplo.com >/dev/null
check "conta desativada não entra"                    "e=credentials"  "$(post - /api/login email=leitor@exemplo.com password=senha-redefinida-aqui)"
post "$ADMIN" /api/admin/users action=enable "userId=$(id_de leitor@exemplo.com)" email=leitor@exemplo.com >/dev/null
zerar_limite
check "reativada volta a entrar"                      "/dashboard"     "$(post - /api/login email=leitor@exemplo.com password=senha-redefinida-aqui)"

# --- trocar a senha precisa derrubar as OUTRAS sessões e manter a atual ---
zerar_limite
SESSAO_A="$TMP/sa.txt"; SESSAO_B="$TMP/sb.txt"
post "$SESSAO_A" /api/login email=leitor@exemplo.com password=senha-redefinida-aqui >/dev/null
zerar_limite
post "$SESSAO_B" /api/login email=leitor@exemplo.com password=senha-redefinida-aqui >/dev/null
check "duas sessões simultâneas funcionam"            "/w/"            "$(get /dashboard "$SESSAO_A")"
post "$SESSAO_B" /api/security/password current_password=senha-redefinida-aqui new_password=senha-final-do-leitor confirm=senha-final-do-leitor >/dev/null
check "trocar a senha derruba a OUTRA sessão"         "/login?next"    "$(get /dashboard "$SESSAO_A")"
check "e mantém de pé a sessão que trocou"            "/w/"            "$(get /dashboard "$SESSAO_B")"

# --- destravar 2FA de quem não tem ---
# Aqui, e não na seção do 2FA: lá o admin tinha acabado de destravar a própria
# conta, o que revoga as sessões dele — a chamada seguinte vinha sem sessão.
check "destravar quem não tem 2FA é recusado"         "e=no_2fa"      "$(post "$ADMIN" /api/admin/users action=reset-2fa "userId=$(id_de leitor@exemplo.com)" email=leitor@exemplo.com)"

# --- trocar e-mail não can valer antes da confirmação ---
post "$ADMIN" /api/security/email email=outro@exemplo.com >/dev/null
check "pedir troca de e-mail NÃO troca o e-mail"      "admin@exemplo.com"   "$(sql "SELECT email FROM user WHERE id = '$(id_de admin@exemplo.com)'")"

echo; echo "$(c 1 'LGPD — exportar e apagar')"
zerar_limite
LGPD="$TMP/lgpd.txt"
post "$LGPD" /api/login email=leitor@exemplo.com password=senha-final-do-leitor >/dev/null
EXPORT="$(curl -s -b "$LGPD" "$BASE/api/account/export")"
check "a exportação responde JSON"                     '"conta"'            "$EXPORT"
check "com o e-mail da pessoa"                         "leitor@exemplo.com" "$EXPORT"
# Credencial não é "dado sobre a pessoa": exportá-la só cria outro jeito de vazar.
check "sem hash de senha no arquivo"                   "0"                  "$(printf '%s' "$EXPORT" | grep -ciE '\$2[aby]\$|scrypt|"password"')"
check "sem segredo de 2FA nem códigos"                 "0"                  "$(printf '%s' "$EXPORT" | grep -ciE '"secret"|"backupCodes"')"
check "quem não tem sessão não exporta nada"           "401"                "$(get /api/account/export)"

# Única owner de um workspace COM outros membros: apagar levaria o trabalho de
# todo mundo junto, então bloqueia e pede transferência.
WS_LEITOR="$(sql "SELECT m.organizationId AS id FROM member m JOIN user u ON u.id=m.userId WHERE u.email='leitor@exemplo.com'" | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["id"])')"
sql "INSERT INTO member (id,organizationId,userId,role,createdAt) VALUES ('m_extra','$WS_LEITOR','$(id_de admin@exemplo.com)','editor',unixepoch())" >/dev/null
check "única owner de workspace compartilhado é bloqueada" "e=last_owner" "$(post "$LGPD" /api/account/delete confirmation=leitor@exemplo.com password=senha-final-do-leitor)"
sql "DELETE FROM member WHERE id='m_extra'" >/dev/null

check "apagar com e-mail de confirmação errado"        "e=confirm_email" "$(post "$LGPD" /api/account/delete confirmation=errado@exemplo.com password=senha-final-do-leitor)"
check "apagar com a senha errada"                      "e=current_password"       "$(post "$LGPD" /api/account/delete confirmation=leitor@exemplo.com password=chute-errado)"
check "apagar com tudo certo"                          "ok=ok_account_deleted" "$(post "$LGPD" /api/account/delete confirmation=leitor@exemplo.com password=senha-final-do-leitor)"
check "a conta sumiu do banco"                         "[]"                  "$(sql "SELECT id FROM user WHERE email='leitor@exemplo.com'")"
check "a auditoria virou desassociada"                 "conta removida"      "$(sql "SELECT actorEmail FROM audit_log WHERE actorEmail='[conta removida]' LIMIT 1")"
check "e nenhum IP dela sobrou na trilha"              "[]"                  "$(sql "SELECT ip FROM audit_log WHERE targetEmail='[conta removida]' AND actorEmail IS NULL AND ip IS NOT NULL")"

echo; echo "$(c 1 'Páginas de erro')"
check "404 usa a página do sistema, não a crua"        "não encontrada"      "$(curl -s -b "$ADMIN" "$BASE/dashboard/rota-que-nao-existe" | grep -oE 'Página não encontrada' | head -1)"
check "/privacy abre sem sessão"                   "200"                 "$(get /privacy)"

echo; echo "$(c 1 'Rate limit (5/min no login)')"
npx wrangler d1 execute "$DB" --local -c "$CFG" --command 'DELETE FROM "rateLimit";' >/dev/null 2>&1
LIMITED=""
for i in 1 2 3 4 5 6 7; do
  [[ "$(post - /api/login email=alvo@exemplo.com "password=chute-numero-$i")" == *"e=rate_limit"* ]] && { LIMITED="$i"; break; }
done
check "o login trava após poucas tentativas"           "trava"  "${LIMITED:+trava na tentativa $LIMITED}"

echo; echo "$(c 1 'Auditoria')"
check "criação do primeiro admin registrada"           "setup.first_admin"  "$(sql "SELECT action FROM audit_log WHERE action='setup.first_admin'")"
check "criação de workspace registrada"                "workspace.created"  "$(sql "SELECT action FROM audit_log WHERE action='workspace.created'")"
check "troca de senha registrada"                      "self.password_changed" "$(sql "SELECT action FROM audit_log WHERE action='self.password_changed'")"
check "ativação do 2FA registrada"                     "self.2fa_enabled"      "$(sql "SELECT action FROM audit_log WHERE action='self.2fa_enabled'")"
check "revogação de sessões registrada"                "user.sessions_revoked" "$(sql "SELECT action FROM audit_log WHERE action='user.sessions_revoked'")"
check "desativação de conta registrada"                "user.disabled"         "$(sql "SELECT action FROM audit_log WHERE action='user.disabled'")"

echo
rm -rf "$TMP"
printf "%s  %d passaram, %d falharam\n" "$([[ $FAIL -eq 0 ]] && c 32 ●  || c 31 ●)" "$PASS" "$FAIL"
exit $(( FAIL > 0 ? 1 : 0 ))
