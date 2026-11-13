-- The project list adds up the entries of each project. Without an index that
-- starts with the project, every project made the database walk through all
-- the entries of the workspace: 119 projects x 2,600 entries was 310,000 rows
-- read to draw one list, and the daily read quota of D1 was gone in a few
-- hundred page loads.
CREATE INDEX "time_entry_project_idx" ON "time_entry" ("workspaceId", "projectId");
