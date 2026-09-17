-- ===========================================================================
-- Configurable inactivity timeout
--
-- NHS Trusts set their own session policies, so the timeout is stored per
-- account rather than compiled in. 30 minutes is the starting value; the
-- bounds exist so a Trust cannot be configured into something meaningless
-- (a 10-second timeout that makes the product unusable, or a 3-day one that
-- is not a timeout at all).
-- ===========================================================================

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS inactivity_timeout_minutes integer NOT NULL DEFAULT 30;

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_inactivity_timeout_check;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_inactivity_timeout_check
  CHECK (inactivity_timeout_minutes BETWEEN 5 AND 480);

COMMENT ON COLUMN public.profiles.inactivity_timeout_minutes IS
  'Minutes of inactivity before the session is ended and locally cached '
  'patient data is purged. Adjustable to the deploying organisation''s policy.';
