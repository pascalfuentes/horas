import type { APIRoute } from "astro";

import { note } from "~/db/schema";
import { getDb } from "~/lib/auth";
import { actor, deny, currentWorkspace } from "~/lib/guards";
import { fail, ok, str } from "~/lib/http";
import { PERMISSIONS } from "~/lib/permissions";

export const prerender = false;

/**
 * MÓDULO DE DEMONSTRAÇÃO.
 *
 * O slug está na ROTA, não no corpo: o middleware resolve e confere a
 * membership antes de chegar aqui. Aceitar um `workspaceId` vindo do formulário
 * deixaria qualquer pessoa escrever em qualquer workspace.
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
