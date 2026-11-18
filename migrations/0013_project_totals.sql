-- The sums the project list shows, kept ready instead of added up on every read.
--
-- The list of projects answers, for each project, how much the person tracked
-- on it and how much the whole workspace spent of its budget. Adding that up
-- from the entries reads one row per entry of the workspace: 18,600 rows read
-- to answer with 120 projects, on every load of the Projects screen and on
-- every `list_projects` of an assistant. D1 limits the rows READ per day, and
-- an index does not help: the rows of an index count as well.
--
-- `time_project_total` holds one row per project and person with the sums of
-- that person's entries on that project. The triggers below keep it equal, at
-- all times, to what a GROUP BY over `time_entry` would answer; the list reads
-- these rows (a few hundred) and leaves the entries alone.
--
-- THE UNIT. The time is kept in `ticks` of 1/2^31 of a day (about 40
-- microseconds), as whole numbers. That is the step in which julianday()
-- itself counts for any date between the years 1030 and 6771, so
-- `(julianday(end) - julianday(start)) * 2147483648.0` is always a whole
-- number, and adding and subtracting whole numbers never rounds. The sums are
-- therefore exactly the ones the old query computed from the entries (it added
-- the same differences, times 86400), and seconds = ticks * 86400 / 2^31.
-- Seconds kept as a decimal number would drift a little with every entry
-- edited or removed. Whole milliseconds would not drift, but they would answer
-- differently from before wherever a sum sits exactly on a rounding step:
-- 3 seconds at 150 an hour is 0.125, which the sum of the entries has always
-- shown as 0.12 and whole milliseconds would show as 0.13.
--
-- A RUNNING TIMER (`end` NULL) counts as an entry here, with zero ticks: its
-- time grows by itself, so whoever reads adds it at that moment (see
-- `projectSumsSql` in src/lib/horas.ts).
--
-- No foreign key to the project or to the person, on purpose: the three
-- "gone" triggers at the end remove the rows BEFORE the database cascades to
-- the entries, which a foreign key does not promise, and that order is what
-- keeps the deletion of a workspace or of an account from writing one more row
-- per entry deleted.

CREATE TABLE "time_project_total" (
  "workspaceId"     text    NOT NULL REFERENCES "organization" ("id") ON DELETE CASCADE,
  "projectId"       integer NOT NULL,
  "userId"          text    NOT NULL,
  -- Entries of this person on this project, running timer included.
  "entries"         integer NOT NULL DEFAULT 0,
  -- SUM("billable") of those entries.
  "billableEntries" integer NOT NULL DEFAULT 0,
  -- Time of the finished entries, and of the billable ones among them.
  "ticks"           integer NOT NULL DEFAULT 0,
  "billableTicks"   integer NOT NULL DEFAULT 0,
  PRIMARY KEY ("workspaceId", "projectId", "userId")
) WITHOUT ROWID;

-- While a workspace has a row here, new entries are NOT added to the totals
-- one by one. An import uses it: adding 400 entries one by one writes 400 rows
-- of totals, and D1 also limits the rows WRITTEN per day (an import is what
-- comes closest to that limit). The import inserts this row, the entries, the
-- sums of those entries (one row written per project among them) and removes
-- this row, all in the same transaction (`importData` in src/lib/horas.ts).
-- Outside a transaction this table is always empty.
CREATE TABLE "time_total_hold" (
  "workspaceId" text PRIMARY KEY NOT NULL REFERENCES "organization" ("id") ON DELETE CASCADE
) WITHOUT ROWID;

-- ---------------------------------------------------------------------------
-- An entry is created
-- ---------------------------------------------------------------------------
CREATE TRIGGER "time_entry_total_insert"
AFTER INSERT ON "time_entry"
FOR EACH ROW
WHEN NEW."projectId" IS NOT NULL
 AND NOT EXISTS (SELECT 1 FROM "time_total_hold" WHERE "workspaceId" = NEW."workspaceId")
BEGIN
  INSERT INTO "time_project_total" ("workspaceId", "projectId", "userId", "entries", "billableEntries", "ticks", "billableTicks")
  VALUES (
    NEW."workspaceId", NEW."projectId", NEW."userId", 1, NEW."billable",
    COALESCE(CAST((julianday(NEW."end") - julianday(NEW."start")) * 2147483648.0 AS INTEGER), 0),
    (NEW."billable" = 1) * COALESCE(CAST((julianday(NEW."end") - julianday(NEW."start")) * 2147483648.0 AS INTEGER), 0)
  )
  ON CONFLICT ("workspaceId", "projectId", "userId") DO UPDATE SET
    "entries"         = "entries" + excluded."entries",
    "billableEntries" = "billableEntries" + excluded."billableEntries",
    "ticks"           = "ticks" + excluded."ticks",
    "billableTicks"   = "billableTicks" + excluded."billableTicks";
END;

-- ---------------------------------------------------------------------------
-- An entry is removed
--
-- A row of totals that reaches zero entries is removed, so the table never
-- holds anything a GROUP BY over the entries would not.
-- ---------------------------------------------------------------------------
CREATE TRIGGER "time_entry_total_delete"
AFTER DELETE ON "time_entry"
FOR EACH ROW
WHEN OLD."projectId" IS NOT NULL
BEGIN
  UPDATE "time_project_total" SET
    "entries"         = "entries" - 1,
    "billableEntries" = "billableEntries" - OLD."billable",
    "ticks"           = "ticks" - COALESCE(CAST((julianday(OLD."end") - julianday(OLD."start")) * 2147483648.0 AS INTEGER), 0),
    "billableTicks"   = "billableTicks" - (OLD."billable" = 1) * COALESCE(CAST((julianday(OLD."end") - julianday(OLD."start")) * 2147483648.0 AS INTEGER), 0)
  WHERE "workspaceId" = OLD."workspaceId" AND "projectId" = OLD."projectId" AND "userId" = OLD."userId";
  DELETE FROM "time_project_total"
  WHERE "workspaceId" = OLD."workspaceId" AND "projectId" = OLD."projectId" AND "userId" = OLD."userId" AND "entries" = 0;
END;

-- ---------------------------------------------------------------------------
-- An entry changes and stays on the same project (a timer stopped, a time or
-- the billable mark edited): the difference goes into the same row of totals.
-- An edit that changes none of the three (a description, a tag) writes nothing.
-- ---------------------------------------------------------------------------
CREATE TRIGGER "time_entry_total_update"
AFTER UPDATE OF "billable", "start", "end" ON "time_entry"
FOR EACH ROW
WHEN NEW."projectId" IS NOT NULL
 AND NEW."projectId" IS OLD."projectId" AND NEW."userId" IS OLD."userId" AND NEW."workspaceId" IS OLD."workspaceId"
 AND (NEW."billable" IS NOT OLD."billable" OR NEW."start" IS NOT OLD."start" OR NEW."end" IS NOT OLD."end")
BEGIN
  UPDATE "time_project_total" SET
    "billableEntries" = "billableEntries" + NEW."billable" - OLD."billable",
    "ticks"           = "ticks"
                        + COALESCE(CAST((julianday(NEW."end") - julianday(NEW."start")) * 2147483648.0 AS INTEGER), 0)
                        - COALESCE(CAST((julianday(OLD."end") - julianday(OLD."start")) * 2147483648.0 AS INTEGER), 0),
    "billableTicks"   = "billableTicks"
                        + (NEW."billable" = 1) * COALESCE(CAST((julianday(NEW."end") - julianday(NEW."start")) * 2147483648.0 AS INTEGER), 0)
                        - (OLD."billable" = 1) * COALESCE(CAST((julianday(OLD."end") - julianday(OLD."start")) * 2147483648.0 AS INTEGER), 0)
  WHERE "workspaceId" = NEW."workspaceId" AND "projectId" = NEW."projectId" AND "userId" = NEW."userId";
END;

-- ---------------------------------------------------------------------------
-- An entry moves to another project, to none, or from none (and, should it
-- ever happen, to another person or workspace): it leaves one row of totals
-- as it was and enters the other as it is now. This is also what runs when a
-- project is deleted and the database clears `projectId` of its entries.
-- ---------------------------------------------------------------------------
CREATE TRIGGER "time_entry_total_move"
AFTER UPDATE OF "projectId", "userId", "workspaceId" ON "time_entry"
FOR EACH ROW
WHEN NEW."projectId" IS NOT OLD."projectId" OR NEW."userId" IS NOT OLD."userId" OR NEW."workspaceId" IS NOT OLD."workspaceId"
BEGIN
  UPDATE "time_project_total" SET
    "entries"         = "entries" - 1,
    "billableEntries" = "billableEntries" - OLD."billable",
    "ticks"           = "ticks" - COALESCE(CAST((julianday(OLD."end") - julianday(OLD."start")) * 2147483648.0 AS INTEGER), 0),
    "billableTicks"   = "billableTicks" - (OLD."billable" = 1) * COALESCE(CAST((julianday(OLD."end") - julianday(OLD."start")) * 2147483648.0 AS INTEGER), 0)
  WHERE "workspaceId" = OLD."workspaceId" AND "projectId" = OLD."projectId" AND "userId" = OLD."userId";
  DELETE FROM "time_project_total"
  WHERE "workspaceId" = OLD."workspaceId" AND "projectId" = OLD."projectId" AND "userId" = OLD."userId" AND "entries" = 0;
  INSERT INTO "time_project_total" ("workspaceId", "projectId", "userId", "entries", "billableEntries", "ticks", "billableTicks")
  SELECT
    NEW."workspaceId", NEW."projectId", NEW."userId", 1, NEW."billable",
    COALESCE(CAST((julianday(NEW."end") - julianday(NEW."start")) * 2147483648.0 AS INTEGER), 0),
    (NEW."billable" = 1) * COALESCE(CAST((julianday(NEW."end") - julianday(NEW."start")) * 2147483648.0 AS INTEGER), 0)
  WHERE NEW."projectId" IS NOT NULL
  ON CONFLICT ("workspaceId", "projectId", "userId") DO UPDATE SET
    "entries"         = "entries" + excluded."entries",
    "billableEntries" = "billableEntries" + excluded."billableEntries",
    "ticks"           = "ticks" + excluded."ticks",
    "billableTicks"   = "billableTicks" + excluded."billableTicks";
END;

-- ---------------------------------------------------------------------------
-- A project, a person or a workspace is deleted: its rows of totals go first.
--
-- BEFORE, so that when the database then clears or deletes the entries one by
-- one, the triggers above find no row of totals to update and write nothing.
-- ---------------------------------------------------------------------------
CREATE TRIGGER "time_project_total_project_gone"
BEFORE DELETE ON "time_project"
FOR EACH ROW
BEGIN
  DELETE FROM "time_project_total" WHERE "workspaceId" = OLD."workspaceId" AND "projectId" = OLD."id";
END;

CREATE TRIGGER "time_project_total_user_gone"
BEFORE DELETE ON "user"
FOR EACH ROW
BEGIN
  DELETE FROM "time_project_total" WHERE "userId" = OLD."id";
END;

CREATE TRIGGER "time_project_total_workspace_gone"
BEFORE DELETE ON "organization"
FOR EACH ROW
BEGIN
  DELETE FROM "time_project_total" WHERE "workspaceId" = OLD."id";
END;

-- ---------------------------------------------------------------------------
-- The entries that already exist
--
-- After the triggers, and replacing: an entry written between the two steps
-- was counted by a trigger, and is counted once again here, from scratch,
-- into the row that replaces the trigger's. Reads every entry that has a
-- project, once, and writes one row per project and person.
--
-- To rebuild the table at any time, should it ever be doubted: empty it and
-- run this statement again.
-- ---------------------------------------------------------------------------
INSERT OR REPLACE INTO "time_project_total" ("workspaceId", "projectId", "userId", "entries", "billableEntries", "ticks", "billableTicks")
SELECT "workspaceId", "projectId", "userId",
       COUNT(*),
       SUM("billable"),
       SUM(COALESCE(CAST((julianday("end") - julianday("start")) * 2147483648.0 AS INTEGER), 0)),
       SUM(("billable" = 1) * COALESCE(CAST((julianday("end") - julianday("start")) * 2147483648.0 AS INTEGER), 0))
  FROM "time_entry"
 WHERE "projectId" IS NOT NULL
 GROUP BY "workspaceId", "projectId", "userId";
