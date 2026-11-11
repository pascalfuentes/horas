import type { APIRoute } from "astro";

import { eq } from "drizzle-orm";

import { PLATFORM_ROLES, twoFactor, user as userTable, type PlatformRole } from "~/db/schema";
import { AUDIT, audit } from "~/lib/audit";
import { getDb } from "~/lib/auth";
import { actor, denyPlatform, isLastAdminError } from "~/lib/guards";
import { codeFromAuthError, fail, ok, str } from "~/lib/http";

export const prerender = false;

const PAGE = "/dashboard/admin/users";

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = denyPlatform(locals);
  if (denied) return denied;

  const form = await request.formData();
  const acao = str(form, "action");
  const userId = str(form, "userId");
  const alvoEmail = str(form, "email") || null;
  const me = actor(locals);
  const headers = request.headers;

  if (!userId) return fail(PAGE, "fields");

  const registrar = (action: (typeof AUDIT)[keyof typeof AUDIT], details?: Record<string, unknown>) =>
    audit(locals.env, {
      action,
      actorId: me.id,
      actorEmail: me.email,
      targetId: userId,
      targetEmail: alvoEmail,
      details,
      request,
    });

  try {
    switch (acao) {
      case "role": {
        const role = str(form, "role") as PlatformRole;
        if (!(PLATFORM_ROLES as readonly string[]).includes(role)) return fail(PAGE, "fields");
        // Mesmo sendo admin: mudar o próprio papel é sempre um acidente de
        // trabalho esperando acontecer.
        if (userId === me.id) return fail(PAGE, "own_role");

        await locals.auth.api.setRole({ body: { userId, role }, headers });
        await registrar(AUDIT.USER_ROLE_CHANGED, { novoPapel: role });
        return ok(PAGE, "ok_role");
      }

      case "disable": {
        if (userId === me.id) return fail(PAGE, "own_status");
        await locals.auth.api.banUser({
          body: { userId, banReason: str(form, "reason") || "Desativado por um administrador" },
          headers,
        });
        await registrar(AUDIT.USER_DISABLED);
        return ok(PAGE, "ok_disabled");
      }

      case "enable": {
        await locals.auth.api.unbanUser({ body: { userId }, headers });
        await registrar(AUDIT.USER_ENABLED);
        return ok(PAGE, "ok_enabled");
      }

      case "reset-2fa": {
        // Sem isto, quem perde o celular E os códigos de recuperação fica
        // trancado para sempre — nem o admin conseguia ajudar, só mexendo no
        // banco à mão. Remover o segundo fator devolve o acesso pela senha.
        const db = getDb(locals.env);
        const removidos = await db.delete(twoFactor).where(eq(twoFactor.userId, userId)).returning({ id: twoFactor.id });
        if (removidos.length === 0) return fail(PAGE, "no_2fa");

        await db.update(userTable).set({ twoFactorEnabled: false }).where(eq(userTable.id, userId));
        // As sessões abertas dessa pessoa foram criadas com o segundo fator
        // que acabou de deixar de existir: derrubá-las é o mínimo.
        await locals.auth.api.revokeUserSessions({ body: { userId }, headers });

        await registrar(AUDIT.USER_2FA_RESET);
        return ok(PAGE, "ok_2fa_reset");
      }

      case "revoke-sessions": {
        await locals.auth.api.revokeUserSessions({ body: { userId }, headers });
        await registrar(AUDIT.USER_SESSIONS_REVOKED);
        return ok(PAGE, "ok_sessions");
      }

      default:
        return fail(PAGE, "fields");
    }
  } catch (error) {
    // O trigger do banco abortou: era o último administrador ativo.
    if (isLastAdminError(error)) return fail(PAGE, "last_admin");
    console.error("admin/usuarios:", error);
    return fail(PAGE, codeFromAuthError(error));
  }
};
