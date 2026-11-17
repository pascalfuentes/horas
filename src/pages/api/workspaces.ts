import type { APIRoute } from "astro";

import { AUDIT, audit } from "~/lib/audit";
import { actor, denyAccount } from "~/lib/guards";
import { fail, nameCarriesLink, ok, str } from "~/lib/http";
import { MAX_OWNED_WORKSPACES, countOwnedWorkspaces, createWorkspace } from "~/lib/workspaces";

export const prerender = false;

/**
 * Creating a workspace is an ACCOUNT action, not a workspace one: there is no
 * workspace in context yet. Any authenticated person can create their own.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  const denied = denyAccount(locals);
  if (denied) return denied;

  const name = str(await request.formData(), "name").slice(0, 60);
  if (!name) return fail("/workspaces", "fields");
  if (nameCarriesLink(name, "workspace")) return fail("/workspaces", "invalid_name");

  const me = actor(locals);

  // Creating a workspace is free and each one can send invitations, so a
  // person does not get to open them without end.
  if ((await countOwnedWorkspaces(locals.env, me.id)) >= MAX_OWNED_WORKSPACES) {
    return fail("/workspaces", "workspace_limit");
  }

  try {
    const ws = await createWorkspace(locals.env, { name, ownerId: me.id });

    await audit(locals.env, {
      action: AUDIT.WORKSPACE_CREATED,
      actorId: me.id,
      actorEmail: me.email,
      workspaceId: ws.id,
      details: { name: ws.name, slug: ws.slug, reason: "created by the user" },
      request,
    });

    return ok(`/w/${encodeURIComponent(ws.slug)}`, "ok_workspace_created");
  } catch (error) {
    console.error("create workspace:", error);
    return fail("/workspaces", "error");
  }
};
