-- ===========================================================================
-- Opting context into the letter
--
-- The original design kept uploaded background entirely out of letter
-- generation, because an error in a document summary would otherwise enter
-- the letter as established clinical history — and nobody opens the source
-- PDF to check a sentence that reads like fact.
--
-- The client has asked for a choice. This is that choice, made per
-- consultation and recorded against it.
--
-- Default FALSE, deliberately. The safe behaviour is the one you get by not
-- deciding: a clinician who never notices the toggle gets a letter written
-- from the consultation alone, which is what every letter was written from
-- before this column existed.
--
-- Stored rather than passed from the browser so it is auditable after the
-- fact. "Was this letter written with uploaded background in scope?" is a
-- question that will be asked about a specific letter, possibly long after
-- it was signed, and a request parameter leaves nothing to answer it with.
-- ===========================================================================

ALTER TABLE public.consultation_contexts
  ADD COLUMN IF NOT EXISTS include_in_letter boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.consultation_contexts.include_in_letter IS
  'Whether the clinician chose to let this context inform letter generation. '
  'Defaults to false: a letter written from the consultation alone is the '
  'safe outcome, so it is what not deciding produces. Recorded against the '
  'consultation so the question can be answered about a specific letter '
  'after the fact.';
