import type { APIRoute } from "astro";

import { AUDIT, audit } from "~/lib/audit";
import { actor, denyAccount } from "~/lib/guards";
import { fail, ok, str } from "~/lib/http";
import { createWorkspace } from "~/lib/workspaces";

export const prerender = false;

/**
 * Creating a workspace is an ACCOUNT action, not a workspace one: there is no
 * workspace in context yet. Any authenticated person can create their own.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  const denied = denyAccount(locals);
  if (denied) return denied;

  const name = str(await request.formData(), "name");
  if (!name) return fail("/workspaces", "fields");

  const me = actor(locals);

  try {
    const ws = await createWorkspace(locals.env, { name: name.slice(0, 60), ownerId: me.id });

    await audit(locals.env, {
      action: AUDIT.WORKSPACE_CREATED,
      actorId: me.id,
      actorEmail: me.email,
      workspaceId: ws.id,
      details: { name: ws.name, slug: ws.slug, reason: "created by the user" },
      request,
    });

    return ok(`/w/${ws.slug}`, "ok_workspace_created");
  } catch (error) {
    console.error("create workspace:", error);
    return fail("/workspaces", "error");
  }
};
