#!/usr/bin/env node
import { createHmac } from "node:crypto";
import { pathToFileURL } from "node:url";

/**
 * Generates the TOTP code for a base32 secret, the same one the authenticator
 * app would show. It exists so the test suite can exercise 2FA end to end, and
 * it is useful for debugging "my code is not accepted".
 *
 *   node scripts/totp.mjs JBSWY3DPEHPK3PXP
 */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(input) {
  const clean = input.toUpperCase().replace(/=+$/, "").replace(/\s/g, "");
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of clean) {
    const i = ALPHABET.indexOf(char);
    if (i === -1) throw new Error(`Invalid base32 character: ${char}`);
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function totp(secret, { period = 30, digits = 6, now = Date.now() } = {}) {
  const counter = Math.floor(now / 1000 / period);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));

  const hmac = createHmac("sha1", base32Decode(secret)).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    (hmac[offset + 1] << 16) |
    (hmac[offset + 2] << 8) |
    hmac[offset + 3];

  return String(binary % 10 ** digits).padStart(digits, "0");
}

// `pathToFileURL` and not concatenation: a path with a space becomes `%20` in
// the URL, and the naive comparison failed silently (the script printed nothing).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const secret = process.argv[2];
  if (!secret) {
    console.error("usage: node scripts/totp.mjs <base32-secret>");
    process.exit(1);
  }
  process.stdout.write(totp(secret));
}
