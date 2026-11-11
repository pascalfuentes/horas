/**
 * Single-use tokens (invites and, if needed, any other link-based flow).
 *
 * Rule: the plaintext token exists only inside the request that generates it
 * and in the email. The database stores only the SHA-256. A D1 leak does not
 * allow accepting any invite.
 */

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** 32 bytes of entropy — 256 bits, unguessable. */
export function generateToken(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Constant-time comparison. Comparing a secret with `===` leaks information
 * through response time (it stops at the first differing byte).
 */
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([hashToken(a), hashToken(b)]);
  if (ha.length !== hb.length) return false;
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
  return diff === 0;
}
