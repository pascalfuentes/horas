-- Billing: hourly rate per project, with a default and currency per workspace.
--
-- The amount of an entry is NOT stored: it is computed on read
-- (hours × the project's rate, or the workspace default when the project has none).
-- Changing the rate changes the amount of everything already logged: the same
-- behavior as Clockify, and what you expect when fixing a mistyped rate.

-- NULL = uses the workspace's default rate.
ALTER TABLE "time_project" ADD COLUMN "hourlyRate" real;

CREATE TABLE "time_settings" (
  "workspaceId" text PRIMARY KEY NOT NULL REFERENCES "organization" ("id") ON DELETE CASCADE,
  -- ISO 4217 code. Formatting only: there is no conversion between currencies.
  "currency"    text NOT NULL DEFAULT 'BRL',
  "defaultRate" real NOT NULL DEFAULT 0
);
