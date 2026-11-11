import { defineMiddleware } from "astro:middleware";

import { REQUIRE_2FA_FOR_ADMINS } from "~/config";
import { createAuth } from "~/lib/auth";
import { env } from "~/lib/env";
import { podeAdministrarPlataforma } from "~/lib/permissions";
import { membershipPorSlug } from "~/lib/workspaces";

/** Rotas alcançáveis sem sessão. Tudo que não estiver aqui exige login. */
const PUBLIC_PAGES = new Set([
  "/",
  "/login",
  "/cadastro",
  "/verificar-email",
  "/esqueci-senha",
  "/redefinir-senha",
  "/setup",
  // Chega-se aqui com a senha aceita mas sem sessão ainda — só o cookie
  // temporário do segundo fator. Não há sessão para exigir.
  "/dois-fatores",
  // Pública: o Google exige a URL da política para publicar o app OAuth.
  "/privacidade",
]);

/** Endpoints de API alcançáveis sem sessão — são justamente os que criam uma. */
const PUBLIC_API = new Set([
  "/api/entrar",
  "/api/sair",
  "/api/cadastro",
  "/api/reenviar-verificacao",
  "/api/esqueci-senha",
  "/api/redefinir-senha",
  "/api/setup",
  "/api/dois-fatores",
  "/api/social",
]);

/** Páginas que um usuário JÁ logado não deveria ver. */
const ANONYMOUS_ONLY = new Set([
  "/login",
  "/cadastro",
  "/verificar-email",
  "/esqueci-senha",
  "/redefinir-senha",
  "/setup",
  "/dois-fatores",
]);

/**
 * Algo como `/favicon.ico` ou `/robots.txt`: pedido de arquivo, não de rota.
 * Quando o arquivo não existe, o handler de assets não serve e a requisição
 * cai aqui — sem sessão, viraria um 302 para o login. Deve ser 404.
 */
const LOOKS_LIKE_FILE = /\.[a-z0-9]{1,8}$/i;

/** `/w/<slug>/…` e `/api/w/<slug>/…` — o slug é o que autoriza. */
const ROTA_DE_WORKSPACE = /^\/(?:api\/)?w\/([^/]+)/;

export const onRequest = defineMiddleware(async (context, next) => {
  context.locals.env = env;
  context.locals.auth = createAuth(env);
  context.locals.membership = null;

  const path = context.url.pathname;

  // As rotas do próprio Better Auth cuidam da própria autorização.
  if (path.startsWith("/api/auth/")) return next();

  // API por token e servidor MCP: a autenticação é o token pessoal, conferido
  // dentro do próprio handler (`autenticarToken`). Não há cookie nem sessão
  // aqui — passar pelo portão abaixo só renderia um redirect para o login.
  if (path.startsWith("/api/v1/") || path === "/mcp" || path.startsWith("/mcp/")) return next();

  const isApi = path.startsWith("/api/");
  const protectedArea =
    path.startsWith("/dashboard") ||
    path.startsWith("/w/") ||
    path.startsWith("/workspaces") ||
    isApi;

  // Antes de resolver a sessão: pedido de arquivo não gasta consulta ao banco
  // nem passa pelo portão de autenticação.
  if (!protectedArea && LOOKS_LIKE_FILE.test(path)) return next();

  const payload = await context.locals.auth.api.getSession({ headers: context.request.headers });
  context.locals.user = (payload?.user as App.Locals["user"]) ?? null;
  context.locals.session = payload?.session ?? null;

  // A página de convite é pública: quem ainda não tem conta precisa chegar
  // nela para entender o que é e criar a conta com o e-mail certo. O ACEITE,
  // esse sim, exige sessão — e o plugin ainda confere se o e-mail bate.
  const paginaDeConvite = !isApi && path.startsWith("/convite/");
  const needsSession = paginaDeConvite
    ? false
    : isApi
      ? !PUBLIC_API.has(path)
      : !PUBLIC_PAGES.has(path);

  if (needsSession && !context.locals.user) {
    if (isApi) return new Response("Não autenticado", { status: 401 });
    return context.redirect(`/login?next=${encodeURIComponent(path + context.url.search)}`);
  }

  // ------------------------------------------------------------------
  // Workspace da URL
  //
  // O slug é a fonte da verdade da autorização, e não o
  // `session.activeOrganizationId`: aquele é um valor único por sessão, e com
  // duas abas abertas em workspaces diferentes a segunda trocaria o ativo da
  // primeira — que continuaria parecendo correta na tela enquanto agisse no
  // workspace errado.
  // ------------------------------------------------------------------
  const noWorkspace = path.match(ROTA_DE_WORKSPACE);
  if (noWorkspace && context.locals.user) {
    const slug = decodeURIComponent(noWorkspace[1]);
    const membership = await membershipPorSlug(env, { slug, userId: context.locals.user.id });

    // 404 e não 403, de propósito: "sem permissão" confirmaria que o workspace
    // existe, o que é informação de graça para quem estiver sondando slugs.
    if (!membership) {
      if (isApi) return new Response("Workspace não encontrado", { status: 404 });
      return context.rewrite("/404");
    }

    context.locals.membership = membership;

    // Lembra o último workspace usado, para o /dashboard saber para onde
    // mandar a pessoa depois. Só escreve quando mudou.
    if (context.locals.session?.activeOrganizationId !== membership.workspaceId) {
      await env.DB.prepare(`UPDATE "session" SET "activeOrganizationId" = ?1 WHERE "id" = ?2`)
        .bind(membership.workspaceId, context.locals.session!.id)
        .run()
        .catch((erro) => console.error("sincronizar workspace ativo:", erro));
    }
  }

  // Área de administração da PLATAFORMA — não da aplicação de ninguém.
  if (path.startsWith("/dashboard/admin") || path.startsWith("/api/admin")) {
    if (!podeAdministrarPlataforma(context.locals.user?.role)) {
      if (isApi) return new Response("Sem permissão", { status: 403 });
      return context.redirect("/dashboard?e=sem_permissao");
    }
  }

  // Administrador de plataforma sem 2FA: entra, mas só navega para a tela de
  // configuração. É bloqueio de navegação, não de acesso.
  if (REQUIRE_2FA_FOR_ADMINS && podeAdministrarPlataforma(context.locals.user?.role)) {
    const liberado =
      path === "/dashboard/seguranca/2fa" || path === "/api/seguranca/2fa" || path === "/api/sair";

    if (!context.locals.user?.twoFactorEnabled && !liberado) {
      if (isApi) return new Response("Ative a verificação em duas etapas", { status: 403 });
      return context.redirect("/dashboard/seguranca/2fa?obrigatorio=1");
    }
  }

  // Quem já está logado não tem o que fazer no login nem no cadastro.
  if (context.locals.user && ANONYMOUS_ONLY.has(path)) {
    return context.redirect("/dashboard");
  }

  return next();
});
