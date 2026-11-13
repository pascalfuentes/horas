-- A project can be billed in its own currency (ISO 4217 code).
-- NULL = the workspace currency.
ALTER TABLE "time_project" ADD COLUMN "currency" text;
