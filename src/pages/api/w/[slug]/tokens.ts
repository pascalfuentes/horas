import type { APIRoute } from "astro";

import { criarToken, revogarToken } from "~/lib/api-tokens";
import { AUDIT, audit } from "~/lib/audit";
import { actor, deny, workspaceAtual } from "~/lib/guards";
import { erroJson } from "~/lib/horas-api";
import { PERMISSIONS } from "~/lib/permissions";

export const prerender = false;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

/**
 * Criar e revogar tokens pessoais de API/MCP.
 *
 * Basta ser membro: o token não dá nada além do que a pessoa já pode fazer
 * neste workspace, e o papel é conferido de novo a cada uso.
 *
 * Responde JSON (e não redirect, como os outros endpoints) porque o token em
 * claro precisa aparecer UMA vez na tela — e não pode viajar numa URL.
 */
export const POST: APIRoute = async ({ request, locals, url }) => {
  const denied = deny(locals, PERMISSIONS.CONTENT_READ);
  if (denied) return denied;
  if (request.headers.get("origin") !== url.origin) return erroJson("Origem não permitida.", 403);

  const ws = workspaceAtual(locals);
  const eu = actor(locals);
  const corpo = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!corpo) return erroJson("O corpo precisa ser JSON.", 400);

  if (corpo.acao === "criar") {
    const nome = typeof corpo.nome === "string" ? corpo.nome : "";
    const criado = await criarToken(locals.env, {
      userId: eu.id,
      workspaceId: ws.workspaceId,
      name: nome,
      timezone: typeof corpo.timezone === "string" ? corpo.timezone : undefined,
    });
    if ("erro" in criado) return erroJson(criado.erro, 400);
    await audit(locals.env, {
      action: AUDIT.SELF_API_TOKEN_CREATED,
      actorId: eu.id,
      actorEmail: eu.email,
      workspaceId: ws.workspaceId,
      details: { tokenId: criado.id, nome: nome.slice(0, 60) },
      request,
    });
    return json(criado, 201);
  }

  if (corpo.acao === "revogar" && typeof corpo.id === "string") {
    const ok = await revogarToken(locals.env, { id: corpo.id, userId: eu.id, workspaceId: ws.workspaceId });
    if (!ok) return erroJson("Token não encontrado.", 404);
    await audit(locals.env, {
      action: AUDIT.SELF_API_TOKEN_REVOKED,
      actorId: eu.id,
      actorEmail: eu.email,
      workspaceId: ws.workspaceId,
      details: { tokenId: corpo.id },
      request,
    });
    return json({ ok: true });
  }

  return erroJson("Ação inválida.", 400);
};
