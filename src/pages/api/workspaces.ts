import type { APIRoute } from "astro";

import { AUDIT, audit } from "~/lib/audit";
import { actor, denyAccount } from "~/lib/guards";
import { fail, ok, str } from "~/lib/http";
import { createWorkspace } from "~/lib/workspaces";

export const prerender = false;

/**
 * Criar workspace é ação de CONTA, não de workspace: não existe workspace no
 * contexto ainda. Qualquer pessoa autenticada can criar o seu.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  const denied = denyAccount(locals);
  if (denied) return denied;

  const nome = str(await request.formData(), "name");
  if (!nome) return fail("/workspaces", "fields");

  const me = actor(locals);

  try {
    const ws = await createWorkspace(locals.env, { nome: nome.slice(0, 60), donoId: me.id });

    await audit(locals.env, {
      action: AUDIT.WORKSPACE_CREATED,
      actorId: me.id,
      actorEmail: me.email,
      workspaceId: ws.id,
      details: { nome: ws.nome, slug: ws.slug, motivo: "criado pela pessoa" },
      request,
    });

    return ok(`/w/${ws.slug}`, "ok_workspace_created");
  } catch (error) {
    console.error("criar workspace:", error);
    return fail("/workspaces", "error");
  }
};
