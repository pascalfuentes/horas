import type { APIRoute } from "astro";
import { waitUntil } from "cloudflare:workers";

import { clientIp } from "~/lib/audit";
import { callAuth } from "~/lib/auth";
import { emailLayout, sendEmail } from "~/lib/email";
import { turnstileSecret } from "~/lib/env";
import {
  NAME_MAX,
  PASSWORD_MAX,
  PASSWORD_MIN,
  codeFromAuthError,
  fail,
  isEmail,
  nameCarriesLink,
  ok,
  str,
  verifyTurnstile,
} from "~/lib/http";
import { isCommonPassword } from "~/lib/passwords";
import { userByEmail } from "~/lib/platform";
import { withinLimit } from "~/lib/throttle";

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
 *
 * "The same thing" has to hold for everything that can go wrong, not only for
 * the happy answer. So every check of what was typed, the count of attempts
 * and the robot check all happen for both kinds of address, in the same
 * order. A rule that only the "new address" path applied (a password that is
 * too long, one sign-up too many) answered differently for an address that
 * has an account, and that difference was the account checker again.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  const form = await request.formData();
  const name = str(form, "name").slice(0, NAME_MAX);
  const email = str(form, "email").toLowerCase();
  const password = str(form, "password");

  if (!name || !isEmail(email)) return fail(PAGE, "fields");
  if (nameCarriesLink(name)) return fail(PAGE, "invalid_name");
  if (password.length < PASSWORD_MIN) return fail(PAGE, "password_short");
  if (password.length > PASSWORD_MAX) return fail(PAGE, "password_long");
  if (password !== str(form, "confirm")) return fail(PAGE, "password_mismatch");
  if (isCommonPassword(password, [email, name])) return fail(PAGE, "password_common");

  // Counted here, for both kinds of address. Better Auth counts sign-ups too
  // (same numbers, in `auth.ts`), but only the ones that reach it, and an
  // address that already has an account never does.
  const ip = clientIp(request);
  if (!(await withinLimit(locals.env, `signup:${ip ?? "unknown"}`, { max: 5, windowSeconds: 300 }))) {
    return fail(PAGE, "rate_limit");
  }

  // For a NEW address the token is not validated here: the hook in `auth.ts`
  // validates it, on the path every account creation goes through. A
  // Turnstile token is single-use, so validating in both places would fail on
  // the second.
  const turnstileToken = str(form, "cf-turnstile-response");

  const alreadyExists = await userByEmail(locals.env, email);

  if (alreadyExists) {
    // This path never reaches that hook, so the robot check happens here.
    // Without it, a script could make the site send "someone tried to sign up
    // with your email" to any address that has an account, as often as it
    // liked.
    if (!(await verifyTurnstile(turnstileSecret(locals.env), turnstileToken, ip))) {
      return fail(PAGE, "turnstile");
    }

    // The work a real sign-up does before answering, so the two take about
    // as long.
    await (await locals.auth.$context).password.hash(password);

    // One notice per address every ten minutes is enough to tell its owner,
    // and it leaves after the answer.
    if (await withinLimit(locals.env, `signup-notice:${email}`, { max: 1, windowSeconds: 600 })) {
      waitUntil(notifySignupAttempt(locals.env, email));
    }
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
