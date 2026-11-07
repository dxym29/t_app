-- Store the two translation stages independently while preserving the existing
-- "translation" column as the final/exported translation.
ALTER TABLE public.episodes
  ADD COLUMN IF NOT EXISTS pass1_translation text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS pass2_translation text NOT NULL DEFAULT '';

-- Backfill old rows conservatively: legacy translation is not assumed to be
-- Pass 2 because earlier versions stored only one combined/final field.
