-- ===========================================================================
-- Allow 'draft' as a recordings.status value.
--
-- ROOT CAUSE OF "autosave doesn't work" / "discard doesn't save"
-- -------------------------------------------------------------
-- recordings.status was created with:
--
--   CHECK (status IN ('uploaded','processing','transcribed','letter_generated','error'))
--
-- Both the in-progress autosave and the discard-to-draft path insert rows with
-- status = 'draft', which the constraint rejects. Postgres raised
-- recordings_status_check on every attempt, so no draft row was ever created
-- and nothing appeared in the Recordings list.
--
-- The application code was correct throughout; the schema simply did not permit
-- the value it was writing. letters.status already allows 'draft', which is why
-- the mismatch was easy to miss — only the recordings side was constrained.
-- ===========================================================================

ALTER TABLE public.recordings
  DROP CONSTRAINT IF EXISTS recordings_status_check;

ALTER TABLE public.recordings
  ADD CONSTRAINT recordings_status_check
  CHECK (status IN (
    'draft',            -- in-progress autosave, or a discarded session kept for recovery
    'uploaded',
    'processing',
    'transcribed',
    'letter_generated',
    'error'
  ));
