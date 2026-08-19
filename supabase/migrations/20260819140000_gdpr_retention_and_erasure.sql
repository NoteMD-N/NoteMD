-- ===========================================================================
-- GDPR technical controls: data minimisation, retention, and erasure.
--
-- Covers the parts of UK GDPR that are enforceable in the database:
--   Art. 5(1)(e)  storage limitation  -> automatic audio purge
--   Art. 17       right to erasure    -> gdpr_erase_user()
--   Art. 15/20    access + portability -> gdpr_export_user()
--   Art. 30       records of processing -> processing_audit_log
--
-- Organisational requirements (DPA with sub-processors, DPIA, privacy notice,
-- lawful basis, breach procedure) are NOT satisfied by this migration and are
-- tracked in docs/GDPR-STATUS.md.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Retention policy (Art. 5(1)(e) storage limitation)
--
-- Audio is the highest-risk artefact we hold and is not needed once a letter
-- has been produced. Default 30 days, configurable per clinician because
-- different trusts mandate different retention periods.
-- ---------------------------------------------------------------------------
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS audio_retention_days integer NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS transcript_retention_days integer NOT NULL DEFAULT 3650;

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_audio_retention_days_check;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_audio_retention_days_check
  CHECK (audio_retention_days BETWEEN 1 AND 3650);

-- Records when a recording's audio was purged, so the audit trail survives the
-- deletion of the audio itself.
ALTER TABLE public.recordings
  ADD COLUMN IF NOT EXISTS audio_purged_at timestamptz;

-- ---------------------------------------------------------------------------
-- 2. Processing audit log (Art. 30 + accountability)
--
-- Append-only. Users may read their own rows; nobody can update or delete via
-- the API (no policies granted for those verbs).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.processing_audit_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL,
  action       text NOT NULL,
  resource     text,
  resource_id  uuid,
  detail       jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS processing_audit_log_user_created_idx
  ON public.processing_audit_log (user_id, created_at DESC);

ALTER TABLE public.processing_audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "own audit rows readable" ON public.processing_audit_log;
CREATE POLICY "own audit rows readable"
  ON public.processing_audit_log FOR SELECT
  USING (auth.uid() = user_id);

-- Deliberately no INSERT/UPDATE/DELETE policies: writes come from edge
-- functions using the service role, which bypasses RLS. This makes the log
-- append-only from the client's perspective.

-- ---------------------------------------------------------------------------
-- 3. Audio purge (runs on a schedule; safe to run repeatedly)
--
-- SECURITY DEFINER so it can reach storage.objects, with an empty search_path
-- to prevent search-path hijacking.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.gdpr_purge_expired_audio()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  purged integer := 0;
  rec    record;
BEGIN
  FOR rec IN
    SELECT r.id, r.audio_path, r.user_id
    FROM public.recordings r
    JOIN public.profiles p ON p.user_id = r.user_id
    WHERE r.audio_path IS NOT NULL
      AND r.audio_path <> ''
      AND r.audio_purged_at IS NULL
      AND r.created_at < now() - make_interval(days => p.audio_retention_days)
  LOOP
    DELETE FROM storage.objects
    WHERE bucket_id = 'audio-recordings'
      AND name = rec.audio_path;

    UPDATE public.recordings
    SET audio_purged_at = now(),
        audio_path = ''
    WHERE id = rec.id;

    INSERT INTO public.processing_audit_log (user_id, action, resource, resource_id, detail)
    VALUES (rec.user_id, 'audio_purged_retention', 'recording', rec.id,
            jsonb_build_object('reason', 'retention_period_elapsed'));

    purged := purged + 1;
  END LOOP;

  RETURN purged;
END;
$$;

REVOKE ALL ON FUNCTION public.gdpr_purge_expired_audio() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- 4. Right of access / portability (Art. 15 + 20)
--
-- Returns everything held about the CALLING user as one JSON document.
-- Scoped to auth.uid() so it cannot be used to read another user's data.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.gdpr_export_user()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  uid    uuid := auth.uid();
  result jsonb;
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT jsonb_build_object(
    'exported_at', now(),
    'user_id',     uid,
    'profile',     (SELECT to_jsonb(p) FROM public.profiles p WHERE p.user_id = uid),
    'recordings',  COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM public.recordings r WHERE r.user_id = uid), '[]'::jsonb),
    'letters',     COALESCE((SELECT jsonb_agg(to_jsonb(l)) FROM public.letters l WHERE l.user_id = uid), '[]'::jsonb),
    'templates',   COALESCE((SELECT jsonb_agg(to_jsonb(t)) FROM public.templates t WHERE t.user_id = uid), '[]'::jsonb),
    'audit_log',   COALESCE((SELECT jsonb_agg(to_jsonb(a)) FROM public.processing_audit_log a WHERE a.user_id = uid), '[]'::jsonb)
  ) INTO result;

  INSERT INTO public.processing_audit_log (user_id, action, detail)
  VALUES (uid, 'data_exported', jsonb_build_object('article', '15/20'));

  RETURN result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.gdpr_export_user() TO authenticated;

-- ---------------------------------------------------------------------------
-- 5. Right to erasure (Art. 17)
--
-- Deletes all clinical data for the calling user, including stored audio.
-- The auth.users row is intentionally left to the caller (an edge function
-- using the admin API) so account deletion stays an explicit, separate step.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.gdpr_erase_user()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  uid              uuid := auth.uid();
  deleted_letters  integer := 0;
  deleted_records  integer := 0;
  deleted_objects  integer := 0;
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  DELETE FROM storage.objects
  WHERE bucket_id = 'audio-recordings'
    AND name LIKE uid::text || '/%';
  GET DIAGNOSTICS deleted_objects = ROW_COUNT;

  DELETE FROM public.letters WHERE user_id = uid;
  GET DIAGNOSTICS deleted_letters = ROW_COUNT;

  DELETE FROM public.recordings WHERE user_id = uid;
  GET DIAGNOSTICS deleted_records = ROW_COUNT;

  DELETE FROM public.templates WHERE user_id = uid;

  -- The audit entry is written AFTER the deletes and deliberately retains only
  -- the user id and counts — no clinical content — so we can evidence that the
  -- erasure happened without keeping what was erased.
  INSERT INTO public.processing_audit_log (user_id, action, detail)
  VALUES (uid, 'data_erased', jsonb_build_object(
    'article', '17',
    'letters_deleted', deleted_letters,
    'recordings_deleted', deleted_records,
    'audio_objects_deleted', deleted_objects
  ));

  RETURN jsonb_build_object(
    'erased', true,
    'letters_deleted', deleted_letters,
    'recordings_deleted', deleted_records,
    'audio_objects_deleted', deleted_objects
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.gdpr_erase_user() TO authenticated;

-- ---------------------------------------------------------------------------
-- 6. Schedule the purge (requires pg_cron)
--
-- Wrapped so the migration still applies on projects where pg_cron is not
-- enabled; in that case the purge must be invoked by an external scheduler.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron') THEN
    CREATE EXTENSION IF NOT EXISTS pg_cron;
    PERFORM cron.unschedule('notemd-audio-retention-purge')
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'notemd-audio-retention-purge');
    PERFORM cron.schedule(
      'notemd-audio-retention-purge',
      '30 2 * * *',
      'SELECT public.gdpr_purge_expired_audio();'
    );
  ELSE
    RAISE NOTICE 'pg_cron unavailable - schedule gdpr_purge_expired_audio() externally.';
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Could not schedule purge job: %', SQLERRM;
END;
$$;
