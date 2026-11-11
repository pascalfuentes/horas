#!/usr/bin/env node
import { createHmac } from "node:crypto";
import { pathToFileURL } from "node:url";

/**
 * Gera o código TOTP de um segredo base32 — o mesmo que o app autenticador
 * mostraria. Existe para a bateria de testes conseguir exercitar o 2FA de
 * ponta a ponta, e é útil para depurar "meu código não é aceito".
 *
 *   node scripts/totp.mjs JBSWY3DPEHPK3PXP
 */
const ALFABETO = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(entrada) {
  const limpa = entrada.toUpperCase().replace(/=+$/, "").replace(/\s/g, "");
  let bits = 0;
  let valor = 0;
  const bytes = [];
  for (const char of limpa) {
    const i = ALFABETO.indexOf(char);
    if (i === -1) throw new Error(`Caractere inválido em base32: ${char}`);
    valor = (valor << 5) | i;
    bits += 5;
    if (bits >= 8) {
      bytes.push((valor >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function totp(secret, { periodo = 30, digitos = 6, agora = Date.now() } = {}) {
  const contador = Math.floor(agora / 1000 / periodo);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(contador));

  const hmac = createHmac("sha1", base32Decode(secret)).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binario =
    ((hmac[offset] & 0x7f) << 24) |
    (hmac[offset + 1] << 16) |
    (hmac[offset + 2] << 8) |
    hmac[offset + 3];

  return String(binario % 10 ** digitos).padStart(digitos, "0");
}

// `pathToFileURL` e não concatenação: um caminho com espaço vira `%20` na URL,
// e a comparação ingênua falhava em silêncio (o script não imprimia nada).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const secret = process.argv[2];
  if (!secret) {
    console.error("uso: node scripts/totp.mjs <segredo-base32>");
    process.exit(1);
  }
  process.stdout.write(totp(secret));
}
