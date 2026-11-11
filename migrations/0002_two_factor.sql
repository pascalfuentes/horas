-- Autenticação em dois fatores (TOTP + códigos de recuperação).
--
-- A linha em "twoFactor" nasce com verified = 0: ativar gera o segredo, mas o
-- 2FA só passa a valer quando a pessoa confirma um código. Abandonar a
-- configuração no meio não tranca ninguém para fora.

ALTER TABLE "user" ADD COLUMN "twoFactorEnabled" integer DEFAULT 0;

CREATE TABLE "twoFactor" (
  "id"                      text    PRIMARY KEY NOT NULL,
  "userId"                  text    NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  -- Segredo TOTP e códigos de recuperação. O Better Auth criptografa os dois
  -- com BETTER_AUTH_SECRET antes de gravar.
  "secret"                  text    NOT NULL,
  "backupCodes"             text    NOT NULL,
  "verified"                integer DEFAULT 0,
  -- Trava a conta após tentativas seguidas erradas, para não dar para varrer
  -- os 1.000.000 de códigos possíveis na força bruta.
  "failedVerificationCount" integer DEFAULT 0,
  "lockedUntil"             integer
);
CREATE INDEX "twoFactor_userId_idx" ON "twoFactor" ("userId");
CREATE INDEX "twoFactor_secret_idx" ON "twoFactor" ("secret");
