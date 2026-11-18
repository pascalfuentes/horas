-- The tag list reads a person's tagged entries, newest first. Most entries
-- carry no tag, and the index by person and start holds them all: finding the
-- tagged ones meant walking through the person's whole history (20,000 rows
-- read to answer with a dozen tags), on every load of the Time screen.
--
-- This index holds only the tagged entries, with the tags themselves, so the
-- list is answered from the index alone. The condition here and the one in
-- the query (`listTags` in src/lib/horas.ts) must stay written the same way,
-- or the database stops using it.
CREATE INDEX "time_entry_tagged_idx" ON "time_entry" ("workspaceId", "userId", "start", "tags") WHERE "tags" != '[]';
