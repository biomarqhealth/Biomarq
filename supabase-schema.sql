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

-- The Biomarq Performance app (performance/index.html) shares this same
-- Supabase project and writes its own extra columns into the SAME
-- 'habits' and 'profiles' tables (its check-in form uses fields the main
-- app doesn't). If these weren't added when that app was last set up,
-- every performance check-in save is likely hitting the same "400 Bad
-- Request: column doesn't exist" failure the main app's habits saves had.
ALTER TABLE habits
  ADD COLUMN IF NOT EXISTS performance_rating integer,
  ADD COLUMN IF NOT EXISTS performance_notes text,
  ADD COLUMN IF NOT EXISTS struggles text,
  ADD COLUMN IF NOT EXISTS soreness_level integer,
  ADD COLUMN IF NOT EXISTS rpe integer,
  ADD COLUMN IF NOT EXISTS extra_notes text;

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS sport text,
  ADD COLUMN IF NOT EXISTS sessions_per_day text;
