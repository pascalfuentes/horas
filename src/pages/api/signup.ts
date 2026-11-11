import type { APIRoute } from "astro";

import { callAuth } from "~/lib/auth";
import { emailLayout, sendEmail } from "~/lib/email";
import { codeFromAuthError, fail, isEmail, ok, str } from "~/lib/http";
import { userByEmail } from "~/lib/platform";

export const prerender = false;

const PAGE = "/signup";

/**
 * Open signup.
 *
 * ALWAYS responds the same thing, whether the account exists or not. Better
 * Auth returns `USER_ALREADY_EXISTS` on signup, and passing that along would
 * turn this form into an account checker — the same reason login and password
 * recovery already respond the same for existing and nonexistent emails.
 *
 * When the email already has an account, instead of creating anything, we
 * notify the owner through that same email. Whoever tried learns nothing; the
 * owner finds out.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  const form = await request.formData();
  const name = str(form, "name");
  const email = str(form, "email").toLowerCase();
  const password = str(form, "password");

  if (!name || !isEmail(email)) return fail(PAGE, "fields");
  if (password.length < 10) return fail(PAGE, "password_short");
  if (password !== str(form, "confirm")) return fail(PAGE, "password_mismatch");

  // The token is NOT validated here: the hook in `auth.ts` validates it, on the
  // path every account creation goes through. A Turnstile token is single-use,
  // so validating in both places would fail on the second.
  const turnstileToken = str(form, "cf-turnstile-response");

  const alreadyExists = await userByEmail(locals.env, email);

  if (alreadyExists) {
    await notifySignupAttempt(locals.env, email);
    return ok("/verify-email", "ok_signup");
  }

  try {
    const res = await callAuth(locals.auth, request, "/sign-up/email", {
      name,
      email,
      password,
      turnstileToken,
    });

    if (!res.ok) {
      const body = (await res.clone().json().catch(() => null)) as { code?: string } | null;
      // Race: someone created the account between the check above and now. The
      // response stays the same as always.
      if (String(body?.code ?? "").includes("ALREADY_EXISTS")) {
        return ok("/verify-email", "ok_signup");
      }
      const text = `${body?.code ?? ""} ${(body as { message?: string })?.message ?? ""}`;
      if (text.includes("TURNSTILE_FAILED")) return fail(PAGE, "turnstile");
      return fail(PAGE, codeFromAuthError({ message: text }));
    }
  } catch (error) {
    console.error("signup:", error);
    return fail(PAGE, "error");
  }

  // No session yet, on purpose: `requireEmailVerification` only lets the
  // person in after they prove the address is theirs.
  return ok("/verify-email", "ok_signup");
};

async function notifySignupAttempt(env: App.Locals["env"], email: string) {
  const { html, text } = emailLayout(
    "Someone tried to create an account with your email",
    [
      "We received a signup using this address, which already has an account here. Nothing was changed.",
      "If it was you, just log in as usual — or use “Forgot my password” if you don't remember it.",
      "If it wasn't you, you can ignore this notice.",
    ],
    { label: "Go to login", url: `${env.BETTER_AUTH_URL}/login` },
  );
  await sendEmail(env, { to: email, subject: "Signup attempt with your email", html, text })
    .catch((error) => console.error("duplicate signup notice:", error));
}
