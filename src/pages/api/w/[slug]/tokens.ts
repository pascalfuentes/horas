import type { APIRoute } from "astro";

import { createToken, revokeToken } from "~/lib/api-tokens";
import { AUDIT, audit } from "~/lib/audit";
import { actor, deny, currentWorkspace } from "~/lib/guards";
import { jsonError } from "~/lib/horas-api";
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
 * Basta ser membro: o token não dá nada além do que a pessoa já can fazer
 * neste workspace, e o papel é conferido de novo a cada uso.
 *
 * Responde JSON (e não redirect, como os outros endpoints) porque o token em
 * claro precisa aparecer UMA vez na tela — e não can viajar numa URL.
 */
export const POST: APIRoute = async ({ request, locals, url }) => {
  const denied = deny(locals, PERMISSIONS.CONTENT_READ);
  if (denied) return denied;
  if (request.headers.get("origin") !== url.origin) return jsonError("Origem não permitida.", 403);

  const ws = currentWorkspace(locals);
  const eu = actor(locals);
  const corpo = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!corpo) return jsonError("O corpo precisa ser JSON.", 400);

  if (corpo.action === "create") {
    const nome = typeof corpo.name === "string" ? corpo.name : "";
    const criado = await createToken(locals.env, {
      userId: eu.id,
      workspaceId: ws.workspaceId,
      name: nome,
      timezone: typeof corpo.timezone === "string" ? corpo.timezone : undefined,
    });
    if ("error" in criado) return jsonError(criado.error, 400);
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

  if (corpo.action === "revoke" && typeof corpo.id === "string") {
    const ok = await revokeToken(locals.env, { id: corpo.id, userId: eu.id, workspaceId: ws.workspaceId });
    if (!ok) return jsonError("Token não encontrado.", 404);
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

  return jsonError("Ação inválida.", 400);
};
