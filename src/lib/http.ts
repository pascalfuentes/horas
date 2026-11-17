/**
 * Feedback messages travel as a CODE in the query string, never as free text.
 * That way nothing the user typed comes back reflected in the URL.
 */
export const MESSAGES: Record<string, string> = {
  // errors
  fields: "Fill in all required fields.",
  credentials: "Incorrect email or password.",
  password_short: "Password must be at least 10 characters.",
  password_long: "Password must be at most 200 characters.",
  password_common: "This password is too easy to guess. Choose another one.",
  invalid_name: "Use a name without links or addresses.",
  other_account: "This confirmation link belongs to another account. Sign out and open the link again.",
  workspace_limit: "You have reached the limit of workspaces you can own. Delete one you no longer use.",
  note_limit: "This workspace has reached its limit of notes.",
  password_mismatch: "Passwords don't match.",
  current_password: "Current password is incorrect.",
  invalid_email: "Enter a valid email.",
  email_in_use: "This email can't be used.",
  invalid_invite: "This invitation is invalid, expired or already used.",
  duplicate_invite: "There is already a pending invitation for this email.",
  user_exists: "An account with this email already exists.",
  last_admin: "This is the only active administrator account. Promote someone else first.",
  not_recipient:
    "This invitation is for another email. Sign in with the account for the address that received it.",
  invite_expired: "This invitation has expired or was already used. Ask for a new one.",
  already_member: "This person is already a member of this workspace.",
  invite_pending: "There is already a pending invitation for this email.",
  own_membership: "You can't do this to your own membership.",
  invalid_role: "Invalid role.",
  last_owner:
    "You are the sole owner of a workspace that has other members. Transfer ownership before deleting your account.",
  no_permission: "You don't have permission to do this.",
  email_not_verified: "Confirm your email before signing in. We can resend the link if you need it.",
  turnstile: "We couldn't confirm you're not a robot. Try again.",
  social_unavailable: "This sign-in method isn't available.",
  social_failed:
    "We couldn't sign you in with this account. If it has been disabled, contact an administrator.",
  social_unconfirmed:
    "This email already has an account here that was never confirmed, so we couldn't join the two. Confirm it with the link we emailed you (you can ask for a new one below) and sign in again.",
  rate_limit: "Too many attempts. Wait a moment and try again.",
  own_role: "You can't change your own role.",
  own_status: "You can't disable your own account.",
  confirm_name: "Type the workspace name exactly as shown to confirm.",
  confirm_email: "Type your email exactly as it appears on your account to confirm.",
  error: "Something went wrong. Try again.",
  invalid_code: "Incorrect code. Check the app and try again.",
  code_locked: "Too many wrong attempts. Wait 15 minutes.",
  two_factor_active: "Two-step verification is already enabled on this account.",
  two_factor_required: "Administrator accounts require two-step verification.",

  // successes
  ok_profile: "Profile updated.",
  ok_password: "Password changed. Your other sessions were signed out.",
  ok_email: "We sent a confirmation link to your current email.",
  ok_invite: "Invitation sent.",
  ok_invite_resent: "Invitation resent.",
  ok_invite_revoked: "Invitation revoked.",
  ok_role: "Role updated.",
  ok_disabled: "User disabled.",
  ok_enabled: "User re-enabled.",
  ok_sessions: "Sessions revoked.",
  ok_2fa_reset: "Two-step verification removed. They will set it up again the next time they sign in.",
  no_2fa: "This account doesn't have two-step verification enabled.",
  ok_session: "Session signed out.",
  ok_reset: "If an account exists for this email, we sent a reset link.",
  ok_signup: "Account created. Confirm your email to sign in.",
  ok_verification_resent: "If the address needs confirmation, we sent the link again.",
  ok_email_verified: "Email confirmed. You can sign in now.",
  ok_note: "Note saved.",
  ok_workspace_created: "Workspace created. You are its owner.",
  ok_workspace_renamed: "Workspace renamed.",
  ok_workspace_deleted: "Workspace deleted.",
  ok_invite_sent: "Invitation sent.",
  ok_invite_cancelled: "Invitation canceled.",
  ok_member_role: "Role updated.",
  ok_member_removed: "Member removed.",
  ok_left: "You left the workspace.",
  ok_transferred: "Ownership transferred. You are now an administrator.",
  ok_invite_accepted: "Invitation accepted. Welcome!",
  ok_account_deleted: "Your account was deleted.",
  ok_2fa_enabled: "Two-step verification enabled.",
  ok_2fa_disabled: "Two-step verification disabled.",
  ok_2fa_codes: "New recovery codes generated. The old ones no longer work.",
};

/**
 * The error code a page should show, read from its address.
 *
 * A failed social sign-in comes back as `?e=social_failed`, and Better Auth
 * adds its own `error=<reason>`. One reason deserves its own words: the email
 * already has an account created with a password that was never confirmed.
 * Joining the two is refused on purpose (whoever created that account may not
 * own the address), and "contact an administrator" would send the person the
 * wrong way. They have just proved the address is theirs with the provider,
 * so saying that an account exists reveals nothing to a stranger.
 */
export function errorCodeFrom(params: URLSearchParams): string | null {
  const code = params.get("e");
  if (code === "social_failed" && params.get("error") === "account_not_linked") return "social_unconfirmed";
  return code;
}

export function messageFor(code: string | null): string | null {
  if (!code) return null;
  return MESSAGES[code] ?? null;
}

/** Redirects back to `path` with an error code. */
export function fail(path: string, code: keyof typeof MESSAGES | string, extra?: string): Response {
  const url = `${path}${path.includes("?") ? "&" : "?"}e=${encodeURIComponent(code)}${extra ?? ""}`;
  return new Response(null, { status: 303, headers: { Location: url } });
}

/** Redirects back to `path` with a success code. */
export function ok(path: string, code?: keyof typeof MESSAGES | string): Response {
  const url = code ? `${path}${path.includes("?") ? "&" : "?"}ok=${encodeURIComponent(code)}` : path;
  return new Response(null, { status: 303, headers: { Location: url } });
}

/**
 * Whether a value has the shape of an e-mail address: one `@`, no spaces, and
 * a domain with a dot that has something before it and two characters or more
 * after it.
 *
 * Written by hand, in one pass. The pattern this replaces said the same thing
 * and took time that grew with the square of the length: forty thousand
 * characters held a request for most of a second, on forms anyone can reach
 * without signing in.
 *
 * @param value What was typed.
 * @returns `true` when it can be an address.
 */
export function isEmail(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const text = value.trim();
  // 254 is the longest address a mail server accepts.
  if (text.length < 6 || text.length > EMAIL_MAX) return false;
  if (/\s/.test(text)) return false;

  const at = text.indexOf("@");
  if (at < 1 || at !== text.lastIndexOf("@")) return false;

  // A dot with at least one character before it and two after it.
  const domain = text.slice(at + 1);
  return domain.slice(1, -2).includes(".");
}

/** The longest e-mail address a mail server accepts. */
export const EMAIL_MAX = 254;

/** Limits of what a person may call themselves and of the phone they give. */
export const NAME_MAX = 80;
export const PHONE_MAX = 32;

/** Limits of a password. The same numbers are in `auth.ts`. */
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 200;

/**
 * Whether a name carries something a mail program would turn into a link.
 *
 * Names travel in the e-mails the site sends on a person's behalf ("So-and-so
 * invited you to the workspace Such"). A name is the one place where a
 * stranger chooses words that arrive with the site's own sender and layout, so
 * it must not be able to say "go to this address".
 *
 * @param value The name.
 * @param kind A person's name is stricter: it has no use for `@` or a slash.
 * @returns `true` when the name should be refused.
 */
export function nameCarriesLink(value: string, kind: "person" | "workspace" = "person"): boolean {
  if (/:\/\/|www\./i.test(value)) return true;
  return kind === "person" && /[\/\\@]/.test(value);
}

export function str(form: FormData, key: string): string {
  const v = form.get(key);
  return typeof v === "string" ? v.trim() : "";
}

/**
 * Cloudflare Turnstile. Without a secret it passes straight through — the
 * template runs without requiring you to create a widget first.
 *
 * Callers pass `turnstileSecret(env)`, never the raw variable: that helper
 * only hands the secret over when the sitekey exists too, so the server asks
 * for a token exactly when the page is able to produce one.
 */
export async function verifyTurnstile(
  secret: string | undefined,
  token: string,
  ip: string | null,
): Promise<boolean> {
  if (!secret) return true;
  if (!token) return false;

  const body = new FormData();
  body.set("secret", secret);
  body.set("response", token);
  if (ip) body.set("remoteip", ip);

  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body,
    });
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  } catch {
    return false;
  }
}

/**
 * Better Auth returns a `Response` with the session cookies. HTML forms need a
 * 303, not JSON — so we transplant the Set-Cookie headers.
 */
export function redirectWithCookies(from: Response, location: string): Response {
  const headers = new Headers({ Location: location });
  for (const cookie of from.headers.getSetCookie()) headers.append("set-cookie", cookie);
  return new Response(null, { status: 303, headers });
}

/**
 * With `asResponse: true`, Better Auth does NOT throw on error — it returns a
 * 4xx `Response` with `{ code, message }` in the body. Redirecting without
 * looking at the status sends the person to the dashboard as if they had signed
 * in, they get kicked back to the login and receive no explanation at all.
 *
 * Every call with `asResponse` goes through here.
 */
export async function handleAuthResponse(
  res: Response,
  onSuccess: string,
  onFailure: string,
  /** Rewrites the error code before redirecting (e.g. "wrong current password"). */
  rewrite?: (code: string) => string,
): Promise<Response> {
  if (res.ok) return redirectWithCookies(res, onSuccess);

  const body = (await res.json().catch(() => null)) as { code?: string; message?: string } | null;
  const code = mapAuthCode(`${body?.code ?? ""} ${body?.message ?? ""}`, res.status);
  return fail(onFailure, rewrite ? rewrite(code) : code);
}

/** Error thrown by Better Auth → our message code. */
export function codeFromAuthError(error: unknown): string {
  const raw = `${(error as { body?: { code?: string; message?: string } })?.body?.code ?? ""} ${
    (error as { message?: string })?.message ?? ""
  }`;
  return mapAuthCode(raw, (error as { statusCode?: number })?.statusCode);
}

/** Never leaks internal detail: maps to the messages in `MESSAGES`. */
function mapAuthCode(input: string, status?: number): string {
  const raw = input.toUpperCase();
  if (status === 429) return "rate_limit";

  if (raw.includes("TOO_MANY") || raw.includes("RATE")) return "rate_limit";
  if (raw.includes("INVALID_EMAIL_OR_PASSWORD") || raw.includes("INVALID_PASSWORD")) return "credentials";
  if (raw.includes("PASSWORD_TOO_SHORT")) return "password_short";
  if (raw.includes("PASSWORD_TOO_LONG")) return "password_long";
  if (raw.includes("PASSWORD_TOO_COMMON")) return "password_common";
  if (raw.includes("USER_ALREADY_EXISTS") || raw.includes("EXISTING")) return "user_exists";
  if (raw.includes("BANNED")) return "credentials";
  if (raw.includes("NOT_THE_RECIPIENT")) return "not_recipient";
  if (raw.includes("INVITATION_NOT_FOUND")) return "invite_expired";
  if (raw.includes("ALREADY_MEMBER") || raw.includes("ALREADY_EXISTS_IN_ORGANIZATION")) return "already_member";
  if (raw.includes("INVITATION_ALREADY")) return "invite_pending";
  if (raw.includes("EMAIL_NOT_VERIFIED")) return "email_not_verified";
  // Names from Better Auth's TWO_FACTOR_ERROR_CODES.
  if (raw.includes("TEMPORARILY_LOCKED") || raw.includes("TOO_MANY_ATTEMPTS")) return "code_locked";
  if (raw.includes("ALREADY_ENABLED")) return "two_factor_active";
  if (raw.includes("INVALID_CODE") || raw.includes("INVALID_BACKUP_CODE") || raw.includes("OTP_HAS_EXPIRED")) {
    return "invalid_code";
  }
  if (raw.includes("CONVITE") || raw.includes("INVALID_TOKEN") || raw.includes("EXPIRED")) return "invalid_invite";
  if (raw.includes("EMAIL")) return "email_in_use";
  return "error";
}

/**
 * Prevents open redirects: only accepts a path within the application itself.
 *
 * Starting with one slash is not enough. A browser reads `//host` and
 * `/\host` as another site (a backslash counts as a slash), and it drops tabs
 * and line breaks from an address before reading it, so `/<tab>/host` is
 * `//host` too. Those are refused by what they contain, and then the value is
 * parsed the way a browser would, against an address that does not exist: if
 * the result is anywhere else, it was not a path.
 *
 * An endpoint is refused as well. After signing in a person lands on a page;
 * `/api/...` there would turn the login into a way of making someone call an
 * endpoint with a fresh session.
 *
 * @param value The `next` that came with the request.
 * @param fallback Where to go when it cannot be trusted.
 * @returns A path of this site, with its query and fragment.
 */
export function safeNext(value: string, fallback = "/dashboard"): string {
  if (!value.startsWith("/") || value.startsWith("//") || value.length > 2000) return fallback;
  if (/[\\\u0000-\u001f\u007f]/.test(value)) return fallback;

  const base = "http://path.invalid";
  try {
    const parsed = new URL(value, base);
    if (parsed.origin !== base) return fallback;
    if (parsed.pathname === "/api" || parsed.pathname.startsWith("/api/")) return fallback;
    return parsed.pathname + parsed.search + parsed.hash;
  } catch {
    return fallback;
  }
}
