import { desc, eq, or } from "drizzle-orm";
import type { APIRoute } from "astro";

import { account, auditLog, note, session, user as userTable } from "~/db/schema";
import { getDb } from "~/lib/auth";
import { workspacesDoUsuario } from "~/lib/workspaces";
import { actor, denyConta } from "~/lib/guards";

export const prerender = false;

/**
 * Exportação dos dados pessoais (LGPD, art. 18, II).
 *
 * O que NÃO vai junto: hash de senha, segredo de 2FA, códigos de recuperação e
 * tokens dos provedores sociais. São credenciais, não informação sobre a
 * pessoa — entregá-las num arquivo só cria um jeito novo de vazar a conta.
 */
export const GET: APIRoute = async ({ locals }) => {
  const denied = denyConta(locals);
  if (denied) return denied;

  const me = actor(locals);
  const db = getDb(locals.env);

  const [conta] = await db
    .select({
      id: userTable.id,
      nome: userTable.name,
      email: userTable.email,
      telefone: userTable.phone,
      papel: userTable.role,
      emailVerificado: userTable.emailVerified,
      doisFatoresAtivo: userTable.twoFactorEnabled,
      criadaEm: userTable.createdAt,
      atualizadaEm: userTable.updatedAt,
    })
    .from(userTable)
    .where(eq(userTable.id, me.id));

  const sessoes = await db
    .select({
      criadaEm: session.createdAt,
      expiraEm: session.expiresAt,
      ip: session.ipAddress,
      navegador: session.userAgent,
    })
    .from(session)
    .where(eq(session.userId, me.id))
    .orderBy(desc(session.createdAt));

  const metodosDeLogin = await db
    .select({ provedor: account.providerId, vinculadoEm: account.createdAt })
    .from(account)
    .where(eq(account.userId, me.id));

  const acoes = await db
    .select({
      quando: auditLog.createdAt,
      acao: auditLog.action,
      alvo: auditLog.targetEmail,
      detalhes: auditLog.details,
      ip: auditLog.ip,
    })
    .from(auditLog)
    .where(or(eq(auditLog.actorId, me.id), eq(auditLog.targetId, me.id)))
    .orderBy(desc(auditLog.createdAt));

  // Participações: de quais workspaces a pessoa faz parte e com que papel.
  const participacoes = (await workspacesDoUsuario(locals.env, me.id)).map((w) => ({
    workspace: w.workspaceNome,
    papel: w.role,
  }));

  const anotacoes = await db
    .select({ titulo: note.title, conteudo: note.body, criadaEm: note.createdAt })
    .from(note)
    .where(eq(note.authorId, me.id));

  // Horas lançadas, em todos os workspaces. Projetos são do workspace, não da
  // pessoa — por isso entram só como nome em cada lançamento.
  const lancamentosDeTempo =
    (
      await locals.env.DB.prepare(
        `SELECT o."name" AS workspace, e."description" AS descricao, p."name" AS projeto,
                e."tags", e."billable" AS faturavel, e."start" AS inicio, e."end" AS fim
           FROM "time_entry" e
           JOIN "organization" o ON o."id" = e."workspaceId"
           LEFT JOIN "time_project" p ON p."id" = e."projectId"
          WHERE e."userId" = ?1 ORDER BY e."start"`,
      )
        .bind(me.id)
        .all()
    ).results ?? [];

  const conteudo = JSON.stringify(
    {
      exportadoEm: new Date().toISOString(),
      observacao:
        "Senha, segredo de 2FA, códigos de recuperação e tokens de provedores sociais " +
        "não são exportados: são credenciais de acesso, não dados sobre você.",
      conta,
      participacoes,
      metodosDeLogin,
      sessoes,
      acoes,
      anotacoes,
      lancamentosDeTempo,
    },
    null,
    2,
  );

  return new Response(conteudo, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="meus-dados-${me.email}.json"`,
      "cache-control": "no-store",
    },
  });
};
