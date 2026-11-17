import type { APIRoute } from "astro";
import { waitUntil } from "cloudflare:workers";

import { createToken, revokeToken } from "~/lib/api-tokens";
import { AUDIT, audit } from "~/lib/audit";
import { emailLayout, sendEmail } from "~/lib/email";
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
    // A token is a second key to the account: it keeps working after the
    // password changes and after every session is ended. So its owner hears
    // about each new one, at an address that whoever created it cannot hide.
    waitUntil(notifyTokenCreated(locals.env, me.email, ws.workspaceName, ws.workspaceSlug));
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

/**
 * Tells a person that a token was created in their name.
 *
 * @param env The Worker's bindings.
 * @param email The person's address.
 * @param workspaceName The workspace the token opens.
 * @param workspaceSlug Its address, for the link to the page that lists the tokens.
 * @returns Nothing; a failed send only reaches the log.
 */
async function notifyTokenCreated(
  env: App.Locals["env"],
  email: string,
  workspaceName: string,
  workspaceSlug: string,
): Promise<void> {
  const escaped = workspaceName.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
  const { html, text } = emailLayout(
    "A new API token was created",
    [
      `A personal token for the API and for MCP was just created on your account, for the workspace <strong>${escaped}</strong>.`,
      "If this was you, there is nothing to do.",
      "<strong>If it wasn't, revoke the token on the page below and change your password.</strong> A token keeps working after a password change until it is revoked.",
    ],
    { label: "Review my tokens", url: `${env.BETTER_AUTH_URL}/w/${encodeURIComponent(workspaceSlug)}/integrations` },
  );
  await sendEmail(env, { to: email, subject: "A new API token was created", html, text }).catch((error) =>
    console.error("token notice:", error),
  );
}
