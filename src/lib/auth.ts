import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { createAccessControl } from "better-auth/plugins/access";
import { admin as adminPlugin } from "better-auth/plugins/admin";
import { twoFactor as twoFactorPlugin } from "better-auth/plugins/two-factor";
import { adminAc, defaultStatements } from "better-auth/plugins/admin/access";
import { organization as organizationPlugin } from "better-auth/plugins/organization";
import {
  adminAc as adminAcWorkspace,
  defaultStatements as defaultStatementsWorkspace,
  ownerAc,
} from "better-auth/plugins/organization/access";
import { drizzle } from "drizzle-orm/d1";

import { APP_NAME, INVITE_TTL_DAYS } from "~/config";
import { schema } from "~/db/schema";
import { assertEnv, provedoresSociais, type AppEnv } from "~/lib/env";
import { layoutEmail, sendEmail } from "~/lib/email";
import { verifyTurnstile } from "~/lib/http";
import { criarWorkspace } from "~/lib/workspaces";

/**
 * Duas listas de papéis registradas no Better Auth, para dois plugins
 * diferentes. A matriz em `src/lib/permissions.ts` continua sendo a fonte de
 * verdade das ROTAS DA APLICAÇÃO; o que está aqui governa as rotas do próprio
 * Better Auth. Mantenha os dois alinhados.
 */

// --- PLATAFORMA (plugin admin): quem é superadmin da instalação ---
const statements = { ...defaultStatements, content: ["read", "write"] } as const;
const ac = createAccessControl(statements);

const roles = {
  admin: ac.newRole({ ...adminAc.statements, content: ["read", "write"] }),
  user: ac.newRole({ content: ["read", "write"] }),
};

// --- WORKSPACE (plugin organization): quem pode o quê dentro de um workspace ---
//
// Cuidado com uma armadilha do plugin: passar `roles` SUBSTITUI os defaults, não
// mescla (`has-permission.mjs` faz `{ ...options.roles || defaultRoles }`). Por
// isso `owner` e `admin` são redeclarados aqui a partir de `ownerAc`/`adminAc`
// em vez de herdados.
//
// A validação de NOME de papel do plugin, por outro lado, une os defaults aos
// nossos — então "member" continuaria sendo um nome aceito, criando um papel com
// zero permissões. Por isso a validação de papel acontece na nossa matriz, antes
// de chamar o plugin.
const statementsWorkspace = {
  ...defaultStatementsWorkspace,
  content: ["read", "write"],
} as const;
const acWorkspace = createAccessControl(statementsWorkspace);

const papeisWorkspace = {
  owner: acWorkspace.newRole({ ...ownerAc.statements, content: ["read", "write"] }),
  admin: acWorkspace.newRole({ ...adminAcWorkspace.statements, content: ["read", "write"] }),
  editor: acWorkspace.newRole({ content: ["read", "write"] }),
  viewer: acWorkspace.newRole({ content: ["read"] }),
};

export function getDb(env: AppEnv) {
  return drizzle(env.DB, { schema });
}

export type Auth = ReturnType<typeof build>;

// Uma instância por isolate. `betterAuth()` monta rotas e plugins; refazer isso
// a cada request é desperdício puro.
const cache = new WeakMap<object, Auth>();

export function createAuth(env: AppEnv): Auth {
  const cached = cache.get(env as unknown as object);
  if (cached) return cached;
  const auth = build(env);
  cache.set(env as unknown as object, auth);
  return auth;
}

function build(env: AppEnv) {
  assertEnv(env);
  const db = getDb(env);
  const secure = env.BETTER_AUTH_URL.startsWith("https://");

  return betterAuth({
    appName: APP_NAME,
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [env.BETTER_AUTH_URL],

    database: drizzleAdapter(db, { provider: "sqlite", schema }),

    // ------------------------------------------------------------------
    // Login social
    //
    // Cada provedor só existe quando o par de chaves está configurado — sem
    // elas, os botões somem e a rota recusa. Mesmo princípio do Turnstile:
    // nada meio ligado.
    //
    // Entrar com Google cria a conta na hora, com o e-mail já verificado pelo
    // provedor — e o workspace pessoal vem junto, porque o hook que o cria roda
    // em qualquer caminho de cadastro.
    // ------------------------------------------------------------------
    socialProviders: {
      ...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
        ? { google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } }
        : {}),
      ...(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
        ? { github: { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET } }
        : {}),
    },

    account: {
      accountLinking: {
        // Quem foi convidado, criou senha, e depois entra com Google usando o
        // MESMO e-mail: sem isto, viraria erro em vez de entrar.
        enabled: true,
        // "Confiável" aqui significa: o provedor confirma o e-mail antes de nos
        // contar. Google e GitHub fazem. Vincular por e-mail sem essa garantia
        // deixaria alguém reivindicar a conta de outra pessoa.
        trustedProviders: provedoresSociais(env),
      },
    },

    // ------------------------------------------------------------------
    // Senha
    // ------------------------------------------------------------------
    emailAndPassword: {
      enabled: true,
      // Cadastro ABERTO: qualquer pessoa cria conta. O que impede um endereço
      // alheio de ser usado deixou de ser o convite e passou a ser a
      // verificação de e-mail obrigatória, logo abaixo.
      disableSignUp: false,
      autoSignIn: true,
      minPasswordLength: 10,
      maxPasswordLength: 200,
      // Não negociável com cadastro aberto: sem isto, qualquer pessoa criaria
      // conta com o e-mail de outra e receberia acesso em nome dela.
      requireEmailVerification: true,
      resetPasswordTokenExpiresIn: 60 * 60, // 1h
      // Redefinir senha derruba todas as sessões: se alguém entrou na conta,
      // o reset expulsa essa pessoa. É o ponto do reset.
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => {
        const { html, text } = layoutEmail(
          "Redefinir sua senha",
          [
            `Olá, ${escapeHtml(user.name)}.`,
            "Recebemos um pedido para redefinir a senha da sua conta. O link vale por 1 hora e só pode ser usado uma vez.",
            "Se não foi você, ignore este e-mail — nada muda.",
          ],
          { label: "Redefinir senha", url },
        );
        await sendEmail(env, { to: user.email, subject: "Redefinir sua senha", html, text });
      },
    },

    // ------------------------------------------------------------------
    // Verificação de e-mail (usada na TROCA de e-mail, não no cadastro)
    // ------------------------------------------------------------------
    emailVerification: {
      // Com cadastro aberto, o e-mail de verificação é o primeiro passo real
      // do fluxo, não um extra.
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      expiresIn: 60 * 60,
      sendVerificationEmail: async ({ user, url }) => {
        const { html, text } = layoutEmail(
          "Confirme seu e-mail",
          [`Olá, ${escapeHtml(user.name)}.`, "Confirme este endereço para concluir a alteração. O link vale por 1 hora."],
          { label: "Confirmar e-mail", url },
        );
        await sendEmail(env, { to: user.email, subject: "Confirme seu e-mail", html, text });
      },
    },

    user: {
      additionalFields: {
        phone: { type: "string", required: false, input: true },
      },
      deleteUser: {
        enabled: true,
        // Roda DEPOIS do apagamento dar certo. Se rodasse antes e o trigger de
        // último admin abortasse, a trilha ficaria anonimizada com a conta
        // ainda de pé — o pior dos dois mundos.
        afterDelete: async (deleted) => {
          // A política de privacidade promete preservar a auditoria "de forma
          // desassociada": a ação e o horário continuam, quem fez não.
          await env.DB.prepare(
            `UPDATE "audit_log"
                SET "actorEmail" = '[conta removida]', "actorId" = NULL, "ip" = NULL
              WHERE "actorId" = ?1 OR "actorEmail" = ?2`,
          )
            .bind(deleted.id, deleted.email)
            .run();
          // Quando a pessoa apagada é o ALVO, o IP costuma ser de quem fez a
          // ação — e esse ainda é identificável, então fica. A exceção é a
          // linha sem ator registrado (o aceite do próprio convite, por
          // exemplo): ali o IP é dela, e vai embora junto.
          await env.DB.prepare(
            `UPDATE "audit_log"
                SET "targetEmail" = '[conta removida]',
                    "targetId" = NULL,
                    "ip" = CASE WHEN "actorId" IS NULL AND "actorEmail" IS NULL
                                THEN NULL ELSE "ip" END
              WHERE "targetId" = ?1 OR "targetEmail" = ?2`,
          )
            .bind(deleted.id, deleted.email)
            .run();
        },
      },
      changeEmail: {
        enabled: true,
        // O link de aprovação vai para o endereço ATUAL. Só quem já controla a
        // conta autoriza a troca — sem isso, trocar e-mail vira sequestro.
        updateEmailWithoutVerification: false,
        sendChangeEmailConfirmation: async ({ user, newEmail, url }) => {
          const { html, text } = layoutEmail(
            "Confirmar troca de e-mail",
            [
              `Olá, ${escapeHtml(user.name)}.`,
              `Foi solicitada a troca do e-mail desta conta para <strong>${escapeHtml(newEmail)}</strong>.`,
              "Se foi você, confirme no botão abaixo. <strong>Se não foi, ignore este e-mail e troque sua senha imediatamente.</strong>",
            ],
            { label: "Confirmar troca", url },
          );
          await sendEmail(env, { to: user.email, subject: "Confirmar troca de e-mail", html, text });
        },
      },
    },

    session: {
      expiresIn: 60 * 60 * 24 * 7, // 7 dias
      updateAge: 60 * 60 * 24, // renova no máximo 1x/dia
      // Sessão fica no D1 para poder ser listada e revogada de verdade.
      storeSessionInDatabase: true,
      freshAge: 60 * 15, // ações sensíveis exigem sessão recente
    },

    advanced: {
      useSecureCookies: secure,
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax", secure },
      ipAddress: {
        // Atrás da Cloudflare, o IP real vem neste header.
        ipAddressHeaders: ["cf-connecting-ip", "x-forwarded-for"],
      },
    },

    rateLimit: {
      // Sem isto, o Better Auth só limita em produção — queremos testável em dev.
      enabled: true,
      storage: "database",
      window: 60,
      max: 60,
      customRules: {
        "/sign-in/email": { window: 60, max: 5 },
        "/sign-up/email": { window: 300, max: 5 },
        "/request-password-reset": { window: 600, max: 3 },
        "/reset-password": { window: 600, max: 5 },
        "/change-password": { window: 600, max: 5 },
        "/change-email": { window: 600, max: 3 },
      },
    },

    plugins: [
      // ------------------------------------------------------------------
      // Workspaces (o "organization" do plugin)
      // ------------------------------------------------------------------
      organizationPlugin({
        ac: acWorkspace,
        roles: papeisWorkspace,
        creatorRole: "owner",
        // A tabela de convites do plugin se chamaria `invitation`, nome que já
        // era da tabela de convites global deste projeto. Renomeada para não
        // colidir — as duas têm colunas obrigatórias incompatíveis.
        schema: { invitation: { modelName: "org_invitation" } },
        // Em segundos. Sai do config para não divergir do prazo que a política
        // de privacidade publica.
        invitationExpiresIn: 60 * 60 * 24 * INVITE_TTL_DAYS,
        // O plugin já recusa aceitar convite de outro e-mail
        // (YOU_ARE_NOT_THE_RECIPIENT). Explicitamos a segunda trava em vez de
        // depender da inferência dele: quem aceita precisa ter confirmado o
        // endereço, senão bastaria cadastrar-se com o e-mail de um convidado.
        requireEmailVerificationOnInvitation: true,
        cancelPendingInvitationsOnReInvite: true,
        sendInvitationEmail: async (dados) => {
          const url = `${env.BETTER_AUTH_URL}/convite/${dados.id}`;
          const { html, text } = layoutEmail(
            `Convite para ${escapeHtml(dados.organization.name)}`,
            [
              `${escapeHtml(dados.inviter.user.name)} convidou você para o workspace ` +
                `<strong>${escapeHtml(dados.organization.name)}</strong>.`,
              "Se você ainda não tem conta, crie uma com este mesmo e-mail — o convite " +
                "só vale para o endereço que o recebeu.",
            ],
            { label: "Ver convite", url },
          );
          await sendEmail(env, {
            to: dados.email,
            subject: `Convite para ${dados.organization.name}`,
            html,
            text,
          });
        },
      }),

      twoFactorPlugin({
        // Nome que aparece no app autenticador da pessoa.
        issuer: APP_NAME,
        // Ativar gera o segredo mas NÃO liga o 2FA — só o primeiro código
        // confirmado liga. Assim, abandonar a configuração no meio (QR lido
        // errado, celular sem bateria) não tranca ninguém para fora.
        skipVerificationOnEnable: false,
        // Um código TOTP tem seis dígitos: são 1.000.000 de possibilidades, o
        // que é pouco para quem pode tentar à vontade. Trava depois de cinco.
        accountLockout: { enabled: true, maxFailedAttempts: 5, durationSeconds: 900 },
      }),
      adminPlugin({
        ac,
        roles,
        defaultRole: "user",
        adminRoles: ["admin"],
        bannedUserMessage: "Esta conta está desativada. Fale com um administrador.",
      }),
    ],

    // ------------------------------------------------------------------
    // ------------------------------------------------------------------
    // Workspace pessoal e workspace ativo
    //
    // O portão de convite que existia aqui foi removido: o cadastro agora é
    // ABERTO. O que provava posse do e-mail era o convite; agora é a
    // verificação de e-mail obrigatória, logo acima.
    // ------------------------------------------------------------------
    // ------------------------------------------------------------------
    // Turnstile no ENDPOINT, não só na nossa página
    //
    // `/api/cadastro` validava o Turnstile e depois chamava
    // `/sign-up/email`. Mas o endpoint do Better Auth é público: um POST
    // direto nele criava conta sem passar por desafio nenhum — a proteção
    // anti-bot valia só para quem usasse o formulário.
    //
    // Agora a validação mora aqui, no caminho por onde TODA criação de conta
    // por senha passa. A página apenas repassa o token.
    // ------------------------------------------------------------------
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/sign-up/email") return;
        if (!env.TURNSTILE_SECRET_KEY) return; // sem Turnstile configurado, nada a checar

        // Durante o bootstrap não há sistema a proteger, e a trava é o
        // SETUP_SECRET. A exceção se fecha sozinha: assim que existir um
        // superadmin, o Turnstile passa a valer para sempre.
        const jaTemSuperadmin = await env.DB.prepare(
          `SELECT 1 FROM "user" WHERE "role" = 'admin' AND coalesce("banned", 0) = 0 LIMIT 1`,
        ).first();
        if (!jaTemSuperadmin) return;

        const body = (ctx.body ?? {}) as Record<string, unknown>;
        const token = typeof body.turnstileToken === "string" ? body.turnstileToken : "";
        const ip =
          ctx.request?.headers.get("cf-connecting-ip") ??
          ctx.request?.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
          null;

        if (!(await verifyTurnstile(env.TURNSTILE_SECRET_KEY, token, ip))) {
          throw new APIError("BAD_REQUEST", { message: "TURNSTILE_FALHOU" });
        }
      }),
    },

    databaseHooks: {
      user: {
        create: {
          after: async (novoUsuario) => {
            // Toda pessoa que se cadastra ganha um workspace próprio e vira
            // `owner` dele. Sem isso, uma conta recém-criada não teria onde
            // trabalhar e cairia numa tela vazia.
            //
            // Inserção direta pelo Drizzle (ver src/lib/workspaces.ts): chamar
            // `auth.api.createOrganization` daqui seria reentrante. Em troca os
            // `organizationHooks` não disparam, então a auditoria é registrada
            // aqui mesmo.
            try {
              const ws = await criarWorkspace(env, {
                nome: nomeDoWorkspacePessoal(novoUsuario.name, novoUsuario.email),
                donoId: novoUsuario.id,
              });

              await registrarAuditoria(env, {
                action: "workspace.created",
                actorId: novoUsuario.id,
                actorEmail: novoUsuario.email,
                workspaceId: ws.id,
                details: { nome: ws.nome, slug: ws.slug, motivo: "cadastro" },
              });
            } catch (error) {
              // Falhar aqui deixaria a conta criada e sem workspace. Melhor
              // gritar no log do que seguir em silêncio com um estado quebrado.
              console.error("Falha ao criar o workspace pessoal:", error);
            }
          },
        },
      },

      session: {
        create: {
          before: async (novaSessao) => {
            // O plugin NÃO define a organização ativa no login — não tem `init`
            // nem hooks de sessão. Sem isto, `activeOrganizationId` nasceria
            // nulo e o dashboard não saberia para onde mandar a pessoa.
            //
            // Isto é conveniência, não autorização: quem autoriza é o slug da
            // URL conferido contra a membership.
            const primeiro = await env.DB.prepare(
              `SELECT "organizationId" FROM "member"
                WHERE "userId" = ?1 ORDER BY "createdAt" LIMIT 1`,
            )
              .bind(novaSessao.userId)
              .first<{ organizationId: string }>();

            return {
              data: { ...novaSessao, activeOrganizationId: primeiro?.organizationId ?? null },
            };
          },
        },
      },
    },
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}


/**
 * Chama uma rota do Better Auth pelo handler HTTP, e não por `auth.api.*`.
 *
 * A diferença importa: `auth.api.signInEmail()` executa o endpoint, mas pula a
 * camada do roteador — onde mora o RATE LIMITER. Seis tentativas de senha
 * errada passavam sem nunca bater no limite de 5/minuto. Passando pelo handler,
 * o pedido percorre o mesmo caminho de um POST vindo do navegador: rate limit,
 * checagem de origem, hooks e tudo mais.
 *
 * Usado nas rotas de credencial (entrar, convite, reset, troca de senha). As
 * rotas já autenticadas de admin e perfil continuam em `auth.api.*`, onde a
 * sessão é a barreira e a tipagem ajuda mais.
 */
export async function callAuth(
  auth: Auth,
  request: Request,
  path: `/${string}`,
  body: Record<string, unknown>,
): Promise<Response> {
  const headers = new Headers(request.headers);
  headers.set("content-type", "application/json");
  headers.delete("content-length");

  return auth.handler(
    new Request(new URL(`/api/auth${path}`, new URL(request.url).origin), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
  );
}

/**
 * Nome do workspace que nasce junto com a conta. Usa o primeiro nome quando há
 * um; senão cai na parte local do e-mail, que sempre existe.
 */
function nomeDoWorkspacePessoal(nome: string | null | undefined, email: string): string {
  const primeiro = String(nome ?? "").trim().split(/\s+/)[0];
  return `Workspace de ${primeiro || email.split("@")[0]}`;
}

/**
 * Grava na auditoria em SQL cru, e não pelo `audit()` de `~/lib/audit`, porque
 * aquele módulo importa `getDb` daqui — usá-lo criaria um ciclo de imports.
 * Mesmo motivo do `deleteUser.afterDelete` logo acima.
 */
async function registrarAuditoria(
  env: AppEnv,
  entrada: {
    action: string;
    actorId?: string | null;
    actorEmail?: string | null;
    targetId?: string | null;
    targetEmail?: string | null;
    workspaceId?: string | null;
    details?: Record<string, unknown>;
  },
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO "audit_log"
         ("id","createdAt","actorId","actorEmail","action","targetId","targetEmail","details","workspaceId")
       VALUES (?1, unixepoch(), ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    )
      .bind(
        crypto.randomUUID(),
        entrada.actorId ?? null,
        entrada.actorEmail ?? null,
        entrada.action,
        entrada.targetId ?? null,
        entrada.targetEmail ?? null,
        entrada.details ? JSON.stringify(entrada.details) : null,
        entrada.workspaceId ?? null,
      )
      .run();
  } catch (error) {
    // Auditoria nunca derruba a operação que ela está registrando.
    console.error("Falha ao gravar audit_log:", error);
  }
}
