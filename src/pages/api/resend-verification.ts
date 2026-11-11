import type { APIRoute } from "astro";

import { callAuth } from "~/lib/auth";
import { fail, isEmail, ok, str } from "~/lib/http";

export const prerender = false;

/**
 * Resends the verification link. Responds the same for an existing,
 * nonexistent or already verified address — otherwise it would become an
 * account checker, just as `/forgot-password` already avoids being.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  const email = str(await request.formData(), "email").toLowerCase();
  if (!isEmail(email)) return fail("/verify-email", "invalid_email");

  try {
    await callAuth(locals.auth, request, "/send-verification-email", {
      email,
      callbackURL: "/login?ok=ok_email_verified",
    });
  } catch (error) {
    // Silenced on purpose: see the comment above.
    console.error("resend-verification:", error);
  }

  return ok("/verify-email", "ok_verification_resent");
};
