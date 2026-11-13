/**
 * Application configuration that lives IN THE CODE (it is not secret and does
 * not change between environments). Infrastructure ids live in
 * `wrangler.local.jsonc`; keys live in the Worker's secrets.
 *
 * `npm run new-project` rewrites the APP_NAME here.
 */

/** Shown in the top bar and as the app name inside Better Auth. */
export const APP_NAME = "Clockfolio";

/** How long an invite is valid before it expires. */
export const INVITE_TTL_DAYS = 7;

/**
 * Who answers for the data in the privacy policy.
 *
 * It comes from `vars` in wrangler (wrangler.local.jsonc in this deploy), and
 * not from here, for the same reason as the ids: the template repository should
 * not carry anyone's personal email. The values below are only the fallback.
 */
export function operator(env: { OPERATOR_NAME?: string; OPERATOR_CONTACT?: string }) {
  return {
    name: env.OPERATOR_NAME || APP_NAME,
    contact: env.OPERATOR_CONTACT || "contact@example.com",
  };
}

/**
 * Requires 2FA from administrators.
 *
 * It locks no one out: an admin without 2FA signs in normally and is taken to
 * the setup screen, where they stay until they enable it. It blocks navigation,
 * not access.
 *
 * On by default because the administrator account invites people and changes
 * roles — whoever gets into it can invite themselves back as many times as they
 * like.
 */
export const REQUIRE_2FA_FOR_ADMINS = true;
