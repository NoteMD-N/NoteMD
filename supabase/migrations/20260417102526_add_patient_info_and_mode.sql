ALTER TABLE recordings ADD COLUMN IF NOT EXISTS patient_name text;
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS patient_id text;
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS mode text DEFAULT 'consultation';
ALTER TABLE letters ADD COLUMN IF NOT EXISTS patient_name text;
ALTER TABLE letters ADD COLUMN IF NOT EXISTS patient_id text;
