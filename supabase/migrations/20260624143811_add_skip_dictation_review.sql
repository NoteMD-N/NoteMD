-- Per-user preference: skip the transcript-review step for dictation, generating
-- the letter immediately after Stop. Off by default — users opt in from Settings.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS skip_dictation_review boolean NOT NULL DEFAULT false;
