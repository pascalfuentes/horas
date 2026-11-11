# astro-auth-template

Template de aplicação com o setor de autenticação pronto. Você clona, roda um
comando, e começa a escrever a sua aplicação **dentro** de um sistema que já
tem login, convites, papéis, sessões e auditoria funcionando.

**Multi-tenant por workspace**: qualquer pessoa cria conta, ganha um workspace
próprio, e convida quem quiser para ele. Quem can o quê é decidido pelo papel
**dentro de cada workspace**, não por um papel global.

```
Astro 7 (SSR)  ·  Cloudflare Workers  ·  D1 + Drizzle  ·  Better Auth  ·  Resend
```

## O que já vem pronto

| | |
|---|---|
| **Cadastro aberto** | com verificação de e-mail obrigatória, Turnstile e rate limit |
| **Entrar** | e-mail + senha, com Turnstile opcional e rate limit |
| **Workspace pessoal** | criado junto com a conta; quem se cadastra vira `owner` dele |
| **Convidar** | por workspace, com papel definido no convite; quem recebe é avisado no painel |
| **Membros** | trocar papel, remover, sair, transferir a propriedade |
| **Recuperar senha** | link por e-mail, uso único, derruba todas as sessões |
| **Perfil** | nome e telefone |
| **Trocar senha** | exige a senha atual, encerra as outras sessões |
| **Trocar e-mail** | link de aprovação vai para o endereço **atual** |
| **Sessões** | listar dispositivos ativos e encerrar individualmente |
| **2FA** | TOTP + códigos de recuperação, obrigatório para admin |
| **Login social** | Google e GitHub — a conta nasce com o e-mail já verificado |
| **Papéis** | por workspace: `owner`, `admin`, `editor`, `viewer` |
| **Superadmin** | papel de plataforma separado, só para quem opera a instalação |
| **Auditoria** | quem fez o quê, com quem, quando, de qual IP |
| **Destravar 2FA** | admin devolve o acesso de quem perdeu o celular e os códigos |
| **LGPD** | baixar os próprios dados e apagar a conta, com política de privacidade |

## Experimentar em dois minutos

Sem conta na Cloudflare, sem configurar nada:

```bash
npm install
cp .dev.vars.example .dev.vars
npm run db:local
npm run dev
```

Abra <http://localhost:4321>. Sem superadmin você cai em `/setup` — use o
`SETUP_SECRET` do `.dev.vars` e crie a conta que vai operar a instalação. Depois
dá para criar contas normais em `/signup`. Os e-mails (verificação, convite,
recuperação de senha) são impressos no terminal em vez de enviados, o que basta
para percorrer todos os fluxos.

```bash
npm run smoke   # 135 verificações de ponta a ponta
```

## Começar um projeto novo

No GitHub, clique em **Use this template → Create a new repository**. Depois:

```bash
git clone <seu-repositorio-novo> && cd <ele>
npm install
npm run new-project
```

O `new-project` pergunta o nome da aplicação, cria o banco D1 e grava tudo em
**`wrangler.local.jsonc`** — um arquivo fora do Git com os ids reais deste
deploy. O `wrangler.jsonc` versionado permanece com placeholders, para que o
próximo clone também comece limpo.

Depois ele imprime o que falta: migrations, secrets e deploy.

> **Por que dois arquivos de config.** Um template que carrega um
> `database_id` real é uma armadilha: você clona para um cliente, roda
> `npm run db:remote` antes de trocar o id, e aplica migrations no banco de
> produção de *outro* projeto. O comando não reclamaria — o id é válido e o
> banco existe. Aqui o clone nasce com um placeholder, `db:remote` recusa
> enquanto ele estiver lá, e `db:local` funciona normalmente para você
> desenvolver desde o primeiro minuto.

### Produção

```bash
npm run db:remote

npm run cf -- secret put BETTER_AUTH_SECRET   # openssl rand -base64 32
npm run cf -- secret put BETTER_AUTH_URL      # a URL pública final
npm run cf -- secret put SETUP_SECRET         # apague depois do 1º admin
npm run cf -- secret put RESEND_API_KEY
npm run cf -- secret put EMAIL_FROM

npm run deploy
```

`BETTER_AUTH_URL` precisa ser **exatamente** a URL pública. Se não bater com o
domínio servido, os cookies de sessão e a checagem de origem falham e ninguém
entra.

Depois de criar o primeiro admin em `/setup`, apague o secret:

```bash
npm run cf -- secret delete SETUP_SECRET
```

### E-mail

Sem `RESEND_API_KEY`, os e-mails vão para o log do Worker (`npm run cf -- tail`)
em vez de serem enviados. Dá para validar o fluxo inteiro assim, mas não serve
para uso real: recuperação de senha depende de e-mail chegando.

Para enviar de verdade você precisa de um domínio verificado no
[Resend](https://resend.com) — DKIM, dois CNAME de SPF e, de preferência,
DMARC. Se o domínio estiver na Cloudflare, são quatro registros em DNS only
(nuvem cinza; proxiados, a verificação nunca passa).

### Login social (opcional)

Crie um app OAuth no provedor e aponte o *redirect URI* para
`https://SEU-DOMINIO/api/auth/callback/google` (ou `/github`). Depois:

```bash
npm run cf -- secret put GOOGLE_CLIENT_ID
npm run cf -- secret put GOOGLE_CLIENT_SECRET
```

O mesmo para `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`. Cada provedor só
aparece quando o **par** de chaves existe — configurar metade não liga nada.

Para desenvolvimento local, as mesmas quatro variáveis vão no `.dev.vars`, com o
redirect apontando para `http://localhost:4321/api/auth/callback/google`.

### Turnstile (proteção anti-bot)

```bash
npm run cf -- turnstile widget create "meu-app" --domain meu-dominio.com --mode managed
```

A `sitekey` é pública e vai em `vars` no `wrangler.local.jsonc`; a chave secreta
vai em `npm run cf -- secret put TURNSTILE_SECRET_KEY`.

O widget só é renderizado quando as **duas** chaves existem. Isso é proposital:
com apenas a sitekey, a pessoa resolveria o desafio e o servidor não checaria
nada — proteção de mentira é pior que nenhuma, porque parece que está lá.

**Para desligar em emergência**, se o Turnstile travar o login de alguém:

```bash
npm run cf -- secret delete TURNSTILE_SECRET_KEY
```

O widget some e a verificação passa a ser ignorada, nos dois lados ao mesmo
tempo. O rate limit continua de pé.

## Colocar a sua aplicação dentro

O módulo **Anotações** existe para isso: é o exemplo de referência de uma área
de negócio protegida pela matriz de permissões. Copie o padrão dele.

São seis pontos de contato:

| # | Arquivo | O que fazer |
|---|---|---|
| 1 | `migrations/000N_….sql` | criar a tabela (uma migration nova, nunca editando as antigas) |
| 2 | `src/db/schema.ts` | espelhar a tabela em Drizzle |
| 3 | `src/lib/permissions.ts` | reaproveitar `content:read`/`content:write` ou criar a sua permissão |
| 4 | `src/pages/dashboard/….astro` | a página (lê do banco, usa `can()` só para esconder o que falharia) |
| 5 | `src/pages/api/….ts` | o endpoint de escrita, começando com `deny(locals, PERMISSIONS.X)` |
| 6 | `src/layouts/Dashboard.astro` | o link na navegação lateral |

A regra que não can ser quebrada é a do item 5: **toda rota que escreve começa
com `deny()`**. Esconder o botão na interface não é autorização — é só cortesia
com quem não ia conseguir mesmo.

Vale acrescentar a verificação correspondente em `scripts/smoke.sh`, no bloco
de autorização. É uma linha, e é o que impede a permissão de silenciosamente
parar de valer numa refatoração futura.

### Remover o módulo de exemplo

Quando a sua aplicação de verdade estiver no lugar:

- `src/pages/dashboard/notes.astro` e `src/pages/api/notes.ts` — apagar
- `migrations/0000_init.sql` — a tabela `note` (ou uma migration nova com `DROP TABLE`)
- `src/db/schema.ts` — o `note` e a entrada em `schema`
- `src/layouts/Dashboard.astro` — o link "Anotações"
- `src/lib/http.ts` — a mensagem `ok_nota`
- `scripts/smoke.sh` — as verificações que usam `/api/notes`

## Como está organizado

```
wrangler.jsonc         config do TEMPLATE (placeholders, vai para o Git)
wrangler.local.jsonc   config DESTE deploy (ids reais, fora do Git)

migrations/
  0000_init.sql        tabelas (Better Auth + convite, auditoria, exemplo)
  0001_invariants.sql  TRIGGERS do "sempre tem que ter um admin"
src/
  config.ts            nome da aplicação e validade do convite
  middleware.ts        resolve a sessão e faz o portão grosso das rotas
  db/schema.ts         espelho Drizzle das migrations
  lib/
    auth.ts            Better Auth + plugins + callAuth()
    workspaces.ts      criar workspace, membership, slug
    plataforma.ts      consultas sobre a instalação (superadmins, usuários)
    permissions.ts     matriz papel × permissão
    guards.ts          deny() para handlers de API
    audit.ts           trilha de auditoria
    errors.ts          desembrulha erros do D1 (LAST_ADMIN, UNIQUE)
  pages/
    login · cadastro · verificar-email · dois-fatores
    esqueci-senha · redefinir-senha · setup · privacidade · 404 · 500
    dashboard/         perfil · seguranca · seguranca/2fa (conta)
    w/[slug]/          início · notas (exemplo) · membros · configuracoes
    convite/[id]       aceite, público — quem não tem conta precisa chegar nele
    workspaces         listar e criar
    dashboard/admin/   usuarios · auditoria (só o superadmin)
    api/               endpoints de formulário (funcionam sem JavaScript)
scripts/
  new-project.mjs     clone → projeto novo
  config.mjs           resolve qual wrangler.jsonc vale
  d1.mjs               migrations, com a trava de produção
  totp.mjs             gera código TOTP (usado pela bateria; útil para depurar)
  cf.mjs               wrangler apontando para a config certa
  smoke.sh             bateria de ponta a ponta
```

As migrations são **escritas à mão** — o `drizzle-kit` não gera os triggers do
invariante. `src/db/schema.ts` é o espelho tipado; ao mexer numa, mexa na outra.

## Decisões que valem entender

### O convite é do e-mail que o recebeu, e de mais ninguém

Duas travas, as duas do plugin, e as duas necessárias:

1. O e-mail da **sessão** precisa ser o do convite. Sem isso, quem interceptasse
   o link entraria com a própria conta no workspace de outra pessoa.
2. O e-mail precisa estar **verificado**. Sem isso, bastaria cadastrar-se com o
   endereço de um convidado para herdar o convite dele — e o cadastro é aberto.

A página `/invite/[id]` é pública, porque quem ainda não tem conta precisa
chegar nela e entender o que criar. O que ela mostra — nome do workspace e
e-mail convidado — é o que quem tem o link já recebeu por e-mail. O **aceite**
é que tem as travas.

Ninguém é convidado como `owner`: dono se torna por transferência, que é uma
ação deliberada de quem já é dono.

### O convite também aparece dentro do painel

O link do e-mail não can ser o único caminho. E-mail se perde, cai em spam, ou
é apagado sem querer — e aí a pessoa fica sem saída mesmo já estando logada,
porque nada na interface indica que existe um convite esperando por ela.

Então o painel avisa: um aviso no topo de toda página, com o nome do workspace,
o papel oferecido, quem convidou, e os botões de aceitar e recusar. A lista
completa fica em `/workspaces`, e o aviso do topo é omitido lá para não
duplicar.

O que **não** muda é quem autoriza. Os botões postam no mesmo
`/api/invite/accept` da página pública, e as duas travas continuam sendo do
plugin. O aviso decide o que aparece na tela; ele não decide nada sobre acesso.

A consulta casa pelo **e-mail**, que é a mesma chave que o plugin confere no
aceite — não pelo `userId`, que o convite nem conhece. E tem teto de 20: criar
workspace é livre, então sem limite alguém poderia abrir dezenas e convidar a
mesma pessoa de cada um só para entulhar a tela dela.

### Transferir a propriedade promove antes de rebaixar

A ordem não é estética. Promover a pessoa nova primeiro deixa o workspace com
dois donos por um instante; rebaixar primeiro deixaria zero, e o trigger
`keep_one_owner_on_update` abortaria — corretamente, porque o workspace ficaria
sem dono no meio do caminho.

Quem transfere vira `admin`: continua trabalhando, perde só o que é exclusivo de
dono. E o último dono **não consegue sair** do workspace — quem garante isso é o
trigger, não a aplicação.

### O workspace mora na URL, não na sessão

O plugin guarda a organização ativa em `session.activeOrganizationId` — **um
valor único por sessão**. Com duas abas abertas em workspaces diferentes, a
segunda troca o ativo da primeira, e a primeira continua parecendo correta na
tela enquanto age no workspace errado. Num produto onde cada workspace é o site
de um cliente, isso é destrutivo, não cosmético.

Por isso a URL é a fonte da verdade: `/w/[slug]/…` e `/api/w/[slug]/…`. O
middleware lê o slug, confere a membership e preenche `locals.membership`. Toda
escrita usa o workspace resolvido dali — nunca um `workspaceId` vindo do
formulário, que deixaria qualquer pessoa escrever em qualquer workspace.

`activeOrganizationId` continua existindo, com um papel só: lembrar o último
workspace usado, para o `/dashboard` saber para onde mandar a pessoa.

Workspace de que você não é membro responde **404, não 403**. "Sem permissão"
confirmaria que aquele slug existe — informação de graça para quem estiver
sondando.

### Papéis dentro do workspace

| | `owner` | `admin` | `editor` | `viewer` |
|---|:-:|:-:|:-:|:-:|
| Ler conteúdo | ✓ | ✓ | ✓ | ✓ |
| Escrever conteúdo | ✓ | ✓ | ✓ | — |
| Ver membros | ✓ | ✓ | ✓ | ✓ |
| Convidar e gerenciar membros | ✓ | ✓ | — | — |
| Configurações do workspace | ✓ | ✓ | — | — |
| Excluir o workspace | ✓ | — | — | — |
| Transferir a propriedade | ✓ | — | — | — |

Repare no que **não** está na tabela: mexer na própria conta. A conta existe fora
de qualquer workspace — a mesma pessoa can ser `owner` num e `viewer` noutro, e
a senha é uma só. Guardar isso por papel de workspace misturaria duas perguntas
diferentes, então quem cuida disso é um guard separado (`denyAccount`). Quem é só
`viewer` continua trocando a própria senha e o próprio 2FA.

São três guards porque são três perguntas: `denyAccount` (é você?), `deny` (você
can isto neste workspace?) e `denyPlatform` (você opera a instalação?).

### Dois níveis de papel, e só um deles decide o dia a dia

`user.role` (plataforma) responde uma pergunta só: **quem opera a instalação**.
Não decide nada dentro de workspace nenhum. Valores: `admin` e `user`.

`member.role` (workspace) é quem decide ler e escrever: `owner`, `admin`,
`editor`, `viewer`. É por workspace, então a mesma pessoa can ser `owner` num e
`viewer` noutro.

O superadmin **não** ganha passe livre em workspace alheio: para agir num
workspace, precisa ser membro dele. Fail-closed.

### Cadastro aberto exige verificação de e-mail

Enquanto o acesso era por convite, receber o convite já provava posse do
endereço. Com cadastro aberto isso some, e `requireEmailVerification: true` passa
a ser o que impede alguém de criar conta com o e-mail de outra pessoa.

O cadastro também **não revela se um e-mail já tem conta**: responde a mesma
coisa nos dois casos, e quando a conta existe avisa o dono por e-mail em vez de
contar para quem tentou. É o mesmo princípio que o login e a recuperação de
senha já seguiam.

### Todo workspace tem ao menos um owner, garantido no banco

Mesmo raciocínio do último admin, agora por workspace — e com uma armadilha a
mais. O trigger precisa de `EXISTS (SELECT 1 FROM organization ...)` na cláusula
`WHEN`: sem isso ele dispara durante o CASCADE de apagar o workspace e torna a
exclusão **impossível**. Verificado empiricamente, e a bateria tem um teste só
para impedir essa regressão.

Consequência prática ao apagar uma conta: se a pessoa é a única owner, o
workspace precisa ser apagado ANTES do usuário. Na ordem inversa o banco recusa.
Quando o workspace tem outros membros, apagar a conta é bloqueado — levaria o
trabalho de todo mundo junto.

Um segundo trigger garante que `member.role` seja **exatamente um** dos quatro
papéis: o Better Auth aceita papéis separados por vírgula e resolve permissão com
`split(",")`, o que abriria um buraco no trigger de owner, que compara com `=`.

### "Sempre tem que ter um admin" mora no banco

Checar em JavaScript não resolve: duas requisições simultâneas leem "existem 2
admins", as duas passam, e você fica com zero. O invariante está em
`migrations/0001_invariants.sql`, como `TRIGGER ... RAISE(ABORT, 'LAST_ADMIN')`
no `UPDATE` de `role`/`banned` e no `DELETE`. Nem um `UPDATE` manual no D1
consegue rebaixar o último administrador ativo.

A aplicação ainda bloqueia os casos óbvios (ninguém muda o próprio papel, ninguém
desativa a própria conta) e traduz o `LAST_ADMIN` numa mensagem legível — mas a
garantia é do banco.

### Rotas de credencial passam pelo handler HTTP

`callAuth()` monta um `Request` e chama `auth.handler()` em vez de
`auth.api.signInEmail()`. A diferença é o **rate limiter**, que vive na camada do
roteador: chamando `auth.api.*` direto, seis tentativas de senha errada passavam
sem nunca bater no limite de 5/minuto. As rotas já autenticadas (admin, perfil)
continuam em `auth.api.*`, onde a sessão é a barreira.

### Nada de enumeração de contas

Senha errada e e-mail inexistente devolvem a mesma mensagem. `/forgot-password`
sempre responde "se existir uma conta, enviamos o link" — inclusive quando o
envio falha. Mensagens de erro são **códigos** na querystring (`?e=credenciais`),
nunca texto vindo do usuário.

### Apagar conta preserva a auditoria, mas desassocia

A política de privacidade promete os dois direitos da LGPD que importam aqui:
baixar os próprios dados e apagar a conta. As duas rotas existem, e as escolhas
que elas fazem estão escritas na própria página.

Na exportação ficam de fora hash de senha, segredo de 2FA, códigos de
recuperação e tokens dos provedores sociais. São credenciais de acesso, não
informação sobre a pessoa — entregá-las num arquivo só cria um jeito novo de
vazar a conta.

Ao apagar, a trilha de auditoria **não** vai junto: ela existe para a segurança
de todas as pessoas do sistema, e apagá-la abriria um buraco justamente onde
mais importaria. O que acontece é dissociação — e-mails viram
`[conta removida]`, ids viram nulos, e o IP some quando ele era da própria
pessoa apagada. Quando o IP é de quem *executou* a ação (um admin revogando
sessões, por exemplo), ele fica, porque essa pessoa continua identificável e
responsável.

O trigger de último admin continua valendo: a única conta de administrador ativa
não consegue se apagar.

### 2FA que não tranca ninguém para fora

Duas escolhas fazem a diferença entre proteção e dor de cabeça.

**Ativar não liga o 2FA.** `/two-factor/enable` gera o segredo, mas
`twoFactorEnabled` só vira verdadeiro quando a pessoa confirma o primeiro
código. Quem leu o QR errado, ficou sem bateria ou fechou a aba no meio
simplesmente continua entrando com a senha.

**Obrigatório para admin, mas como bloqueio de navegação.** Com
`REQUIRE_2FA_FOR_ADMINS` (em `src/config.ts`, ligado por padrão), um admin sem
2FA entra normalmente e é levado para a tela de configuração, onde fica até
ativar. Ninguém perde o acesso — e a conta que convida gente e muda papéis não
anda desprotegida, porque quem entra nela se convida de volta quantas vezes
quiser.

O segredo e os códigos de recuperação aparecem **uma única vez**, na resposta do
Better Auth. Por isso a página de configuração responde ao próprio POST em vez
de redirecionar: redirecionar os perderia, e passá-los pela querystring seria
jogar segredo no histórico do navegador e nos logs do servidor.

O painel de administração tem **Destravar**, que remove o segundo fator de quem
perdeu o celular *e* os códigos de recuperação. Sem isso, a pessoa ficaria
trancada para sempre e nem um admin conseguiria ajudar — só mexendo no banco à
mão. A ação revoga as sessões dela e fica registrada na auditoria.

Códigos de recuperação valem uma vez cada, e cinco códigos errados seguidos
travam a conta por 15 minutos — seis dígitos são só um milhão de possibilidades,
o que é pouco para quem can tentar à vontade.

## O que NÃO está aqui

Deixado de fora de propósito, para você somar quando precisar:

- **SSO / OIDC** — se um dia isto virar serviço central em vez de template por
  projeto, o plugin `oidcProvider` é o caminho, sem reescrever o resto.
- **Testes unitários** — `scripts/smoke.sh` cobre o caminho completo, mas não
  substitui testes de unidade.

## Comandos

| | |
|---|---|
| `npm run new-project` | transforma um clone num projeto novo |
| `npm run dev` | servidor local com D1 e secrets reais do workerd |
| `npm run smoke` | bateria de 135 verificações de ponta a ponta |
| `npm run check` | typecheck (`astro check`) |
| `npm run build` | build de produção |
| `npm run deploy` | build + deploy |
| `npm run db:local` | migrations no D1 local |
| `npm run db:remote` | migrations em produção (recusa se o id for do template) |
| `npm run db:sql -- "SELECT …"` | consulta rápida no banco local |
| `node scripts/totp.mjs <segredo>` | gera o código TOTP de um segredo |
| `npm run cf -- <args>` | `wrangler` apontando para a config certa |

A CI (`.github/workflows/ci.yml`) roda typecheck, build e a bateria completa a
cada push. Tudo local: não precisa de credencial da Cloudflare e não toca
produção.

## Licença

MIT — veja [LICENSE](LICENSE).
