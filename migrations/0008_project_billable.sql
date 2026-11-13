-- "Billable by default" per project.
--
-- An entry created on a project without saying whether it is billable takes
-- this value. It is only a default: each entry keeps its own flag, so changing
-- it here does not touch entries that already exist.
ALTER TABLE "time_project" ADD COLUMN "billable" integer NOT NULL DEFAULT 0;
