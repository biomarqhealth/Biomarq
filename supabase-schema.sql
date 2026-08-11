-- Biomarq schema patch — matches what's actually missing from the live
-- database as of 2026-08-11. Safe to re-run: everything is IF NOT EXISTS,
-- so it only adds columns that aren't there yet and never touches
-- existing rows.
--
-- biomarkers and profiles already have every column the app needs.
-- habits was missing the fields below, which is why saving habits
-- returned "400 Bad Request" (Postgres rejects inserts/updates that
-- reference a column that doesn't exist).

ALTER TABLE habits
  ADD COLUMN IF NOT EXISTS sleep_quality integer,
  ADD COLUMN IF NOT EXISTS screen_time_before_bed numeric,
  ADD COLUMN IF NOT EXISTS steps integer,
  ADD COLUMN IF NOT EXISTS time_outdoors numeric,
  ADD COLUMN IF NOT EXISTS water_oz numeric,
  ADD COLUMN IF NOT EXISTS caffeine_servings numeric,
  ADD COLUMN IF NOT EXISTS alcohol_drinks numeric,
  ADD COLUMN IF NOT EXISTS vitamins text,
  ADD COLUMN IF NOT EXISTS mood integer,
  ADD COLUMN IF NOT EXISTS meditation_minutes numeric,
  ADD COLUMN IF NOT EXISTS notes text;
