import type { APIRoute } from "astro";

import { AUDIT, audit } from "~/lib/audit";
import { callAuth } from "~/lib/auth";
import { actor, deny, workspaceAtual } from "~/lib/guards";
import { codeFromAuthError, fail, handleAuthResponse, ok, str } from "~/lib/http";
import { PERMISSIONS } from "~/lib/permissions";

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const ws = workspaceAtual(locals);
  const me = actor(locals);
  const form = await request.formData();
  const acao = str(form, "acao");
  const PAGE = `/w/${ws.workspaceSlug}/configuracoes`;

  try {
    if (acao === "renomear") {
      const negado = deny(locals, PERMISSIONS.WORKSPACE_WRITE);
      if (negado) return negado;

      const nome = str(form, "nome");
      if (!nome) return fail(PAGE, "campos");

      // Só o nome muda; o slug fica. Trocar o slug quebraria todo link já
      // compartilhado deste workspace, inclusive os que estão em e-mails.
      const res = await callAuth(locals.auth, request, "/organization/update", {
        organizationId: ws.workspaceId,
        data: { name: nome.slice(0, 60) },
      });
      if (!res.ok) return handleAuthResponse(res, PAGE, PAGE);

      await audit(locals.env, {
        action: AUDIT.WORKSPACE_RENAMED,
        actorId: me.id,
        actorEmail: me.email,
        workspaceId: ws.workspaceId,
        details: { de: ws.workspaceNome, para: nome },
        request,
      });
      return ok(PAGE, "ok_workspace_renomeado");
    }

    if (acao === "excluir") {
      const negado = deny(locals, PERMISSIONS.WORKSPACE_DELETE);
      if (negado) return negado;

      // Digitar o nome evita o clique impulsivo — excluir leva junto o
      // conteúdo e a participação de todo mundo, e não tem volta.
      if (str(form, "confirmacao").trim() !== ws.workspaceNome) {
        return fail(PAGE, "confirmacao_nome");
      }

      // Registrado ANTES: depois de excluir, a FK do audit_log vira NULL e não
      // haveria mais workspace para apontar.
      await audit(locals.env, {
        action: AUDIT.WORKSPACE_DELETED,
        actorId: me.id,
        actorEmail: me.email,
        workspaceId: ws.workspaceId,
        details: { nome: ws.workspaceNome, slug: ws.workspaceSlug },
        request,
      });

      const res = await callAuth(locals.auth, request, "/organization/delete", {
        organizationId: ws.workspaceId,
      });
      if (!res.ok) return handleAuthResponse(res, "/workspaces", PAGE);

      return ok("/workspaces", "ok_workspace_excluido");
    }

    return fail(PAGE, "campos");
  } catch (error) {
    console.error("configurações do workspace:", error);
    return fail(PAGE, codeFromAuthError(error));
  }
};
