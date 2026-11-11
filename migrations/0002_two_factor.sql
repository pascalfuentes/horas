-- Two-factor authentication (TOTP + recovery codes).
--
-- The row in "twoFactor" starts with verified = 0: enabling generates the
-- secret, but 2FA only takes effect once the person confirms a code.
-- Abandoning the setup halfway does not lock anyone out.

ALTER TABLE "user" ADD COLUMN "twoFactorEnabled" integer DEFAULT 0;

CREATE TABLE "twoFactor" (
  "id"                      text    PRIMARY KEY NOT NULL,
  "userId"                  text    NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  -- TOTP secret and recovery codes. Better Auth encrypts both with
  -- BETTER_AUTH_SECRET before writing them.
  "secret"                  text    NOT NULL,
  "backupCodes"             text    NOT NULL,
  "verified"                integer DEFAULT 0,
  -- Locks the account after consecutive wrong attempts, so the 1,000,000
  -- possible codes cannot be swept by brute force.
  "failedVerificationCount" integer DEFAULT 0,
  "lockedUntil"             integer
);
CREATE INDEX "twoFactor_userId_idx" ON "twoFactor" ("userId");
CREATE INDEX "twoFactor_secret_idx" ON "twoFactor" ("secret");
