/**
 * Tokens de uso único (convite e, se precisar, qualquer outro fluxo por link).
 *
 * Regra: o token em claro existe apenas dentro da requisição que o gera e no
 * e-mail. O banco guarda somente o SHA-256. Um vazamento do D1 não permite
 * aceitar convite nenhum.
 */

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** 32 bytes de entropia — 256 bits, inadivinhável. */
export function generateToken(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Comparação de tempo constante. Comparar segredo com `===` vaza informação
 * pelo tempo de resposta (para no primeiro byte diferente).
 */
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([hashToken(a), hashToken(b)]);
  if (ha.length !== hb.length) return false;
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
  return diff === 0;
}
