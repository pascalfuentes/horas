# Horas

Controle de tempo gratuito que conversa com a sua IA. Timer, projetos e
relatórios na web — e um servidor MCP embutido, para o Claude (ou qualquer
cliente MCP) iniciar timers, lançar horas e responder "quanto trabalhei essa
semana?" por você.

```
Astro 7 (SSR)  ·  Cloudflare Workers  ·  D1  ·  Better Auth  ·  MCP (Streamable HTTP)
```

## O que tem

| | |
|---|---|
| **Timer** | iniciar, parar, continuar um lançamento; um timer por pessoa, sincronizado entre abas e com a IA |
| **Lançamento manual** | dia, início, fim ou duração digitada (`1h30`, `1:30`, `90`); editar, duplicar e excluir |
| **Projetos** | por workspace, com cliente, cor, valor por hora e arquivamento |
| **Faturamento** | moeda e valor/hora padrão do workspace; valor calculado em cada lançamento faturável |
| **Relatórios** | resumo (por projeto, cliente, tag ou descrição) e detalhado; filtros por projeto, cliente, tag e faturável; CSV |
| **MCP** | 13 ferramentas em `/mcp`, autenticadas por token pessoal |
| **API REST** | as mesmas operações em `/api/v1/…` |
| **Contas** | e-mail e senha, Google, GitHub, 2FA, sessões por dispositivo |
| **Workspaces** | um pessoal por conta, convites e papéis (`owner`, `admin`, `editor`, `viewer`) |
| **LGPD** | exportar os próprios dados (com as horas) e apagar a conta |

A parte de contas, workspaces e permissões vem do
[astro-auth-template](docs/base-de-autenticacao.md) — aquele documento explica
as decisões de segurança e continua valendo aqui.

## Rodar localmente

```bash
npm install
cp .dev.vars.example .dev.vars   # troque os dois segredos
npm run db:local
npm run dev
```

Abra <http://localhost:4321>. Sem superadmin você cai em `/setup` — use o
`SETUP_SECRET` do `.dev.vars`. Depois disso a home vira a landing page e
qualquer pessoa cria conta em `/cadastro`. Sem `RESEND_API_KEY`, os e-mails
(verificação, convite, senha) são impressos no terminal.

```bash
npm run smoke   # bateria de ponta a ponta da autenticação (com o dev rodando)
```

## Conectar uma IA

No painel, **API e MCP → Gerar token**. O token aparece uma vez; a própria
tela já mostra os comandos preenchidos.

```bash
claude mcp add --transport http horas https://SEU-DOMINIO/mcp \
  --header "Authorization: Bearer hrs_…"
```

Clientes que só aceitam uma URL (conector personalizado do Claude, por exemplo)
usam `https://SEU-DOMINIO/mcp/hrs_…` — o token vai na URL, então trate-a como
senha.

Ferramentas: `get_status`, `list_entries`, `summary_report`, `list_projects`,
`list_tags`, `get_settings`, `start_timer`, `stop_timer`, `add_entry`,
`update_entry`, `delete_entry`, `create_project`, `update_project`. Quem é
`viewer` no workspace só recebe as seis primeiras.

### API REST

```bash
curl https://SEU-DOMINIO/api/v1/status -H "Authorization: Bearer hrs_…"
```

| Método | Rota | |
|---|---|---|
| GET | `/status` | timer rodando, total de hoje e da semana |
| POST | `/timer/start` · `/timer/stop` | corpo opcional: `description`, `project`, `tags`, `billable`, `start`/`end` |
| GET · POST | `/entries` | filtros: `from`, `to`, `project`, `project_id`, `client`, `tag`, `billable`, `q`, `limit` |
| GET · PATCH · DELETE | `/entries/:id` | |
| GET · POST | `/projects` | `?archived=1` inclui arquivados |
| PATCH · DELETE | `/projects/:id` | |
| GET | `/summary` | mesmos filtros de `/entries`; devolve totais, valor e grupos por projeto, cliente, tag, dia e descrição |
| GET | `/tags` | tags já usadas |
| GET · PATCH | `/settings` | `currency` e `default_rate` do workspace |
| GET | `/export.csv` | mesmos filtros de `/entries` |

Datas: ISO-8601. Sem offset (`2026-11-11T09:00`), valem no fuso do token — o
do navegador que o criou. `from`/`to` aceitam `YYYY-MM-DD`.

## Publicar (GitHub + Cloudflare)

```bash
npm run novo-projeto        # cria o banco D1 e grava wrangler.local.jsonc (fora do Git)
npm run db:remote

npm run cf -- secret put BETTER_AUTH_SECRET   # openssl rand -base64 32
npm run cf -- secret put BETTER_AUTH_URL      # a URL pública final, exata
npm run cf -- secret put SETUP_SECRET         # apague depois do 1º admin
npm run cf -- secret put RESEND_API_KEY       # sem ele ninguém recebe e-mail de verificação
npm run cf -- secret put EMAIL_FROM

npm run deploy
```

Depois abra `/setup` uma vez para criar o superadmin (ele é obrigado a ativar
2FA) e apague o `SETUP_SECRET`.

**Antes de abrir ao público**, três coisas que deixam de ser opcionais:

1. **E-mail de verdade** (Resend com domínio verificado). O cadastro exige
   confirmar o e-mail; sem envio, ninguém além de quem lê o log consegue entrar.
2. **Turnstile** nas telas de cadastro e login — veja o documento da base.
3. **Login social**: crie os apps OAuth no Google e no GitHub com o redirect
   `https://SEU-DOMINIO/api/auth/callback/google` (ou `/github`) e grave
   `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` e `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET`
   como secrets. Cada botão só aparece quando o par existe.

Para deploy automático a cada push, conecte o repositório em **Workers & Pages →
Create → Import a repository** (Workers Builds), com `npm run build` como build
e `npx wrangler deploy` como deploy.

## Onde está o quê

```
migrations/0006_horas.sql         tabelas time_project, time_entry, api_token
migrations/0007_faturamento.sql   valor por hora do projeto e ajustes do workspace
src/lib/horas.ts                  núcleo: toda regra de tempo, amarrada a (workspace, pessoa)
src/lib/horas-api.ts              roteador JSON, o mesmo para web e token
src/lib/horas-mcp.ts              ferramentas MCP
src/lib/api-tokens.ts             criar, revogar e autenticar tokens (só o SHA-256 é guardado)
src/pages/api/w/[slug]/horas/     API da web (sessão por cookie)
src/pages/api/v1/                 API por token
src/pages/mcp/                    servidor MCP
src/pages/w/[slug]/               tempo · relatorios · projetos · integracoes
public/app/horas.js               interface, sem build e sem dependências
src/pages/index.astro             landing page
```

Decisões que valem saber:

- **Cada lançamento é de uma pessoa num workspace.** O store do núcleo nasce
  com os dois ids e toda query filtra por ambos; não há função que aceite outro
  dono por parâmetro. Projetos são do workspace, compartilhados.
- **O token não carrega papel.** Ele aponta para (pessoa, workspace) e o papel
  é lido de `member` a cada requisição — rebaixar ou remover alguém vale na
  hora.
- **Um timer por pessoa por workspace**, garantido por índice único parcial no
  banco, não só na aplicação.
- **O valor de um lançamento não é gravado.** É horas × taxa do projeto (ou a
  padrão do workspace) calculado na leitura; mudar uma taxa recalcula o que já
  foi lançado.
- **MCP stateless.** Cada requisição monta o servidor e responde em JSON; não
  há sessão para guardar, que é o que um Worker quer.

## O que ainda não tem

- OAuth para o MCP (hoje é token pessoal). Vale fazer se a ideia for aparecer
  em diretórios de conectores.
- Relatório do time: cada pessoa vê só as próprias horas, mesmo o dono.
- Planilha semanal (timesheet), calendário e tarefas dentro de projetos.
- Conversão entre moedas: a moeda do workspace é só formatação.
- O módulo de exemplo "Anotações" do template continua no código (a bateria de
  testes de permissão depende dele), só saiu do menu.
