import type { APIRoute } from "astro";

import { note } from "~/db/schema";
import { getDb } from "~/lib/auth";
import { actor, deny, currentWorkspace } from "~/lib/guards";
import { fail, ok, str } from "~/lib/http";
import { PERMISSIONS } from "~/lib/permissions";

export const prerender = false;

/**
 * DEMO MODULE.
 *
 * The slug is in the ROUTE, not in the body: the middleware resolves and checks
 * the membership before getting here. Accepting a `workspaceId` coming from the
 * form would let anyone write to any workspace.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  const denied = deny(locals, PERMISSIONS.CONTENT_WRITE);
  if (denied) return denied;

  const ws = currentWorkspace(locals);
  const form = await request.formData();
  const title = str(form, "title");
  const body = str(form, "body");
  if (!title) return fail(`/w/${ws.workspaceSlug}/notes`, "fields");

  const now = new Date();
  await getDb(locals.env).insert(note).values({
    id: crypto.randomUUID(),
    title: title.slice(0, 160),
    body: body.slice(0, 4000),
    authorId: actor(locals).id,
    workspaceId: ws.workspaceId,
    createdAt: now,
    updatedAt: now,
  });

  return ok(`/w/${ws.workspaceSlug}/notes`, "ok_note");
};
