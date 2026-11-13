-- A project can have a budget: the most that may be spent on it, as an amount
-- of money (in the project currency), as hours, or both. NULL = no limit.
ALTER TABLE "time_project" ADD COLUMN "budgetAmount" real;
ALTER TABLE "time_project" ADD COLUMN "budgetHours" real;
