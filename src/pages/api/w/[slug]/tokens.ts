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
 * Create and revoke personal API/MCP tokens.
 *
 * Being a member is enough: the token grants nothing beyond what the person can
 * already do in this workspace, and the role is checked again on every use.
 *
 * Responds with JSON (not a redirect, like the other endpoints) because the
 * plaintext token must appear ONCE on screen — and cannot travel in a URL.
 */
export const POST: APIRoute = async ({ request, locals, url }) => {
  const denied = deny(locals, PERMISSIONS.CONTENT_READ);
  if (denied) return denied;
  if (request.headers.get("origin") !== url.origin) return jsonError("Origin not allowed.", 403);

  const ws = currentWorkspace(locals);
  const me = actor(locals);
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return jsonError("The body must be JSON.", 400);

  if (body.action === "create") {
    const name = typeof body.name === "string" ? body.name : "";
    const created = await createToken(locals.env, {
      userId: me.id,
      workspaceId: ws.workspaceId,
      name,
      timezone: typeof body.timezone === "string" ? body.timezone : undefined,
    });
    if ("error" in created) return jsonError(created.error, 400);
    await audit(locals.env, {
      action: AUDIT.SELF_API_TOKEN_CREATED,
      actorId: me.id,
      actorEmail: me.email,
      workspaceId: ws.workspaceId,
      details: { tokenId: created.id, name: name.slice(0, 60) },
      request,
    });
    return json(created, 201);
  }

  if (body.action === "revoke" && typeof body.id === "string") {
    const ok = await revokeToken(locals.env, { id: body.id, userId: me.id, workspaceId: ws.workspaceId });
    if (!ok) return jsonError("Token not found.", 404);
    await audit(locals.env, {
      action: AUDIT.SELF_API_TOKEN_REVOKED,
      actorId: me.id,
      actorEmail: me.email,
      workspaceId: ws.workspaceId,
      details: { tokenId: body.id },
      request,
    });
    return json({ ok: true });
  }

  return jsonError("Invalid action.", 400);
};
