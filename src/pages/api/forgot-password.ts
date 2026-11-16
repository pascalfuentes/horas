import type { APIRoute } from "astro";

import { clientIp } from "~/lib/audit";
import { callAuth } from "~/lib/auth";
import { turnstileSecret } from "~/lib/env";
import { fail, isEmail, ok, str, verifyTurnstile } from "~/lib/http";

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const form = await request.formData();
  const email = str(form, "email").toLowerCase();

  if (!isEmail(email)) return fail("/forgot-password", "invalid_email");

  const human = await verifyTurnstile(
    turnstileSecret(locals.env),
    str(form, "cf-turnstile-response"),
    clientIp(request),
  );
  if (!human) return fail("/forgot-password", "turnstile");

  try {
    await callAuth(locals.auth, request, "/request-password-reset", {
      email,
      redirectTo: "/reset-password",
    });
  } catch (error) {
    // Silenced on purpose. Responding differently when the email does not exist
    // turns this form into an account checker.
    console.error("forgetPassword:", error);
  }

  return ok("/forgot-password", "ok_reset");
};
