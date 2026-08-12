-- Biomarq schema patch — full, de-duplicated list of every column the
-- main app and the performance app write to, across all three shared
-- tables. Safe to run any time: every statement is IF NOT EXISTS, so it
-- only adds columns that aren't already there and never touches existing
-- rows. One ALTER TABLE per column on purpose, so a stray copy/paste
-- issue on one line can't break the rest of the script.

ALTER TABLE biomarkers ADD COLUMN IF NOT EXISTS hemoglobin numeric;
ALTER TABLE biomarkers ADD COLUMN IF NOT EXISTS ferritin numeric;
ALTER TABLE biomarkers ADD COLUMN IF NOT EXISTS ck numeric;
ALTER TABLE biomarkers ADD COLUMN IF NOT EXISTS testosterone numeric;
ALTER TABLE biomarkers ADD COLUMN IF NOT EXISTS cortisol numeric;
ALTER TABLE biomarkers ADD COLUMN IF NOT EXISTS tsh numeric;

ALTER TABLE habits ADD COLUMN IF NOT EXISTS smoking_status text;
ALTER TABLE habits ADD COLUMN IF NOT EXISTS cigarettes_per_day numeric;
ALTER TABLE habits ADD COLUMN IF NOT EXISTS years_since_quit numeric;
ALTER TABLE habits ADD COLUMN IF NOT EXISTS vaping_status text;
ALTER TABLE habits ADD COLUMN IF NOT EXISTS sleep_quality integer;
ALTER TABLE habits ADD COLUMN IF NOT EXISTS screen_time_before_bed numeric;
ALTER TABLE habits ADD COLUMN IF NOT EXISTS steps integer;
ALTER TABLE habits ADD COLUMN IF NOT EXISTS time_outdoors numeric;
ALTER TABLE habits ADD COLUMN IF NOT EXISTS water_oz numeric;
ALTER TABLE habits ADD COLUMN IF NOT EXISTS caffeine_servings numeric;
ALTER TABLE habits ADD COLUMN IF NOT EXISTS alcohol_drinks numeric;
ALTER TABLE habits ADD COLUMN IF NOT EXISTS vitamins text;
ALTER TABLE habits ADD COLUMN IF NOT EXISTS mood integer;
ALTER TABLE habits ADD COLUMN IF NOT EXISTS meditation_minutes numeric;
ALTER TABLE habits ADD COLUMN IF NOT EXISTS notes text;
ALTER TABLE habits ADD COLUMN IF NOT EXISTS performance_rating integer;
ALTER TABLE habits ADD COLUMN IF NOT EXISTS performance_notes text;
ALTER TABLE habits ADD COLUMN IF NOT EXISTS struggles text;
ALTER TABLE habits ADD COLUMN IF NOT EXISTS soreness_level integer;
ALTER TABLE habits ADD COLUMN IF NOT EXISTS rpe integer;
ALTER TABLE habits ADD COLUMN IF NOT EXISTS extra_notes text;

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS medical_history text;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS medical_history_findings text;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS sport text;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS sessions_per_day text;
