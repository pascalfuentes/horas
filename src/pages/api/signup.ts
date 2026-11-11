import type { APIRoute } from "astro";

import { callAuth } from "~/lib/auth";
import { emailLayout, sendEmail } from "~/lib/email";
import { codeFromAuthError, fail, isEmail, ok, str } from "~/lib/http";
import { userByEmail } from "~/lib/platform";

export const prerender = false;

const PAGE = "/signup";

/**
 * Cadastro aberto.
 *
 * Responde SEMPRE a mesma coisa, exista a conta ou não. O Better Auth devolve
 * `USER_ALREADY_EXISTS` no cadastro, e repassar isso transformaria este
 * formulário num verificador de contas — o mesmo motivo pelo qual o login e a
 * recuperação de senha já respondem igual para e-mail existente e inexistente.
 *
 * Quando o e-mail já tem conta, em vez de criar nada, avisamos o dono pelo
 * próprio e-mail. Quem tentou não descobre nada; quem é dono fica sabendo.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  const form = await request.formData();
  const nome = str(form, "name");
  const email = str(form, "email").toLowerCase();
  const senha = str(form, "password");

  if (!nome || !isEmail(email)) return fail(PAGE, "fields");
  if (senha.length < 10) return fail(PAGE, "password_short");
  if (senha !== str(form, "confirm")) return fail(PAGE, "password_mismatch");

  // O token NÃO é validado aqui: quem valida é o hook em `auth.ts`, no caminho
  // por onde toda criação de conta passa. Um token do Turnstile é de uso único,
  // então validar nos dois lugares falharia no segundo.
  const turnstileToken = str(form, "cf-turnstile-response");

  const jaExiste = await userByEmail(locals.env, email);

  if (jaExiste) {
    await avisarTentativaDeCadastro(locals.env, email);
    return ok("/verify-email", "ok_signup");
  }

  try {
    const res = await callAuth(locals.auth, request, "/sign-up/email", {
      name: nome,
      email,
      password: senha,
      turnstileToken,
    });

    if (!res.ok) {
      const corpo = (await res.clone().json().catch(() => null)) as { code?: string } | null;
      // Corrida: alguém criou a conta entre a checagem acima e agora. A
      // resposta continua sendo a mesma de sempre.
      if (String(corpo?.code ?? "").includes("ALREADY_EXISTS")) {
        return ok("/verify-email", "ok_signup");
      }
      const texto = `${corpo?.code ?? ""} ${(corpo as { message?: string })?.message ?? ""}`;
      if (texto.includes("TURNSTILE_FALHOU")) return fail(PAGE, "turnstile");
      return fail(PAGE, codeFromAuthError({ message: texto }));
    }
  } catch (error) {
    console.error("cadastro:", error);
    return fail(PAGE, "error");
  }

  // Sem sessão ainda, de propósito: `requireEmailVerification` só libera a
  // entrada depois que a pessoa provar que o endereço é dela.
  return ok("/verify-email", "ok_signup");
};

async function avisarTentativaDeCadastro(env: App.Locals["env"], email: string) {
  const { html, text } = emailLayout(
    "Alguém tentou criar uma conta com o seu e-mail",
    [
      "Recebemos um cadastro usando este endereço, que já tem conta aqui. Nada foi alterado.",
      "Se foi você, é só entrar normalmente — ou usar “Esqueci minha senha” se não lembrar dela.",
      "Se não foi você, can ignorar este aviso.",
    ],
    { label: "Ir para o login", url: `${env.BETTER_AUTH_URL}/login` },
  );
  await sendEmail(env, { to: email, subject: "Tentativa de cadastro com o seu e-mail", html, text })
    .catch((error) => console.error("aviso de cadastro duplicado:", error));
}
