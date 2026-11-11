import type { APIRoute } from "astro";

import { AUDIT, audit } from "~/lib/audit";
import { callAuth, getDb } from "~/lib/auth";
import { user as userTable } from "~/db/schema";
import { codeFromAuthError, fail, handleAuthResponse, isEmail, str } from "~/lib/http";
import { countPlatformAdmins, userByEmail } from "~/lib/platform";
import { timingSafeEqual } from "~/lib/tokens";
import { eq } from "drizzle-orm";

export const prerender = false;

/**
 * Bootstrap do superadmin da plataforma.
 *
 * A condição mudou junto com o cadastro aberto. Antes era "banco vazio", o que
 * virou uma corrida: bastava alguém se cadastrar primeiro para o superadmin
 * ficar impossível de criar. Agora a trava é **não existir superadmin ativo** —
 * o que continua sendo verdade até alguém assumir o posto.
 *
 * Duas travas, como antes: `SETUP_SECRET` precisa estar configurada e bater.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.env;
  const form = await request.formData();

  if (!env.SETUP_SECRET) return fail("/setup", "no_permission");
  if (!(await timingSafeEqual(str(form, "secret"), env.SETUP_SECRET))) {
    return fail("/setup", "no_permission");
  }
  if ((await countPlatformAdmins(env)) > 0) return fail("/login", "no_permission");

  const nome = str(form, "name");
  const email = str(form, "email").toLowerCase();
  const senha = str(form, "password");

  if (!nome || !isEmail(email)) return fail("/setup", "fields");
  if (senha.length < 10) return fail("/setup", "password_short");
  if (senha !== str(form, "confirm")) return fail("/setup", "password_mismatch");

  const db = getDb(env);
  const existente = await userByEmail(env, email);

  try {
    if (!existente) {
      // Passa pelo cadastro normal — um caminho só para criar usuário, que é
      // também o que garante o workspace pessoal pelo hook.
      const res = await callAuth(locals.auth, request, "/sign-up/email", {
        name: nome,
        email,
        password: senha,
      });
      if (!res.ok) return handleAuthResponse(res, "/setup", "/setup");
    }

    const alvo = existente ?? (await userByEmail(env, email));
    if (!alvo) return fail("/setup", "error");

    // Promove a superadmin e dispensa a verificação de e-mail: quem tem o
    // SETUP_SECRET é o operator da instalação, não um visitante.
    await db
      .update(userTable)
      .set({ role: "admin", emailVerified: true })
      .where(eq(userTable.id, alvo.id));

    await audit(env, { action: AUDIT.SETUP_FIRST_ADMIN, targetEmail: email, request });

    // Entra na hora. A verificação acabou de ser dispensada acima, então o
    // login por senha passa.
    const entrada = await callAuth(locals.auth, request, "/sign-in/email", {
      email,
      password: senha,
    });
    return handleAuthResponse(entrada, "/dashboard", "/login");
  } catch (error) {
    console.error("setup:", error);
    return fail("/setup", codeFromAuthError(error));
  }
};
