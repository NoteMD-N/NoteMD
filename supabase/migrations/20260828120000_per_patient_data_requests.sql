-- ===========================================================================
-- Per-patient data subject requests (UK GDPR Art. 15, 17, 20)
--
-- Erasure and export previously operated per CLINICIAN ACCOUNT. A data subject
-- request concerns ONE PATIENT, so satisfying it required a manual database
-- operation. These functions make it a supported, audited action.
--
-- Matching
-- --------
-- patient_id (NHS number) is the reliable key and is matched exactly, after
-- stripping spaces so "943 476 5919" and "9434765919" are the same patient.
-- patient_name is matched case-insensitively and only when no id is supplied,
-- because names are not unique — the UI therefore always previews what will be
-- affected before anything is deleted.
--
-- Scope
-- -----
-- Every function is scoped to auth.uid(). A clinician can only ever reach
-- their own patients' records; there is no cross-clinician path.
-- ===========================================================================

-- Normalise an NHS number / patient id for comparison.
CREATE OR REPLACE FUNCTION public.gdpr_norm_patient_id(v text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT NULLIF(regexp_replace(COALESCE(v, ''), '[^0-9A-Za-z]', '', 'g'), '');
$$;

-- ---------------------------------------------------------------------------
-- 1. Locate — preview what a request would affect (Art. 15)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.gdpr_find_patient_records(
  p_patient_id   text DEFAULT NULL,
  p_patient_name text DEFAULT NULL
)
RETURNS TABLE (
  recording_id     uuid,
  letter_id        uuid,
  patient_name     text,
  patient_id       text,
  created_at       timestamptz,
  status           text,
  has_audio        boolean,
  has_letter       boolean,
  transcript_chars integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  uid       uuid := auth.uid();
  norm_id   text := public.gdpr_norm_patient_id(p_patient_id);
  norm_name text := NULLIF(btrim(lower(COALESCE(p_patient_name, ''))), '');
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF norm_id IS NULL AND norm_name IS NULL THEN
    RAISE EXCEPTION 'Provide a patient ID or a patient name';
  END IF;

  RETURN QUERY
  SELECT
    r.id,
    l.id,
    COALESCE(r.patient_name, l.patient_name),
    COALESCE(r.patient_id, l.patient_id),
    r.created_at,
    r.status,
    (r.audio_path IS NOT NULL AND r.audio_path <> ''),
    (l.id IS NOT NULL AND l.letter_content IS NOT NULL),
    COALESCE(length(l.transcript), 0)
  FROM public.recordings r
  LEFT JOIN public.letters l ON l.recording_id = r.id
  WHERE r.user_id = uid
    AND (
      -- An id, when given, is authoritative.
      (norm_id IS NOT NULL AND (
         public.gdpr_norm_patient_id(r.patient_id) = norm_id
         OR public.gdpr_norm_patient_id(l.patient_id) = norm_id))
      OR
      -- Otherwise fall back to an exact, case-insensitive name match.
      (norm_id IS NULL AND norm_name IS NOT NULL AND (
         btrim(lower(r.patient_name)) = norm_name
         OR btrim(lower(l.patient_name)) = norm_name))
    )
  ORDER BY r.created_at DESC;
END;
$$;

GRANT EXECUTE ON FUNCTION public.gdpr_find_patient_records(text, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- 2. Export — one patient's data as JSON (Art. 15 / 20)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.gdpr_export_patient(
  p_patient_id   text DEFAULT NULL,
  p_patient_name text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  uid    uuid := auth.uid();
  ids    uuid[];
  result jsonb;
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT array_agg(f.recording_id)
  INTO ids
  FROM public.gdpr_find_patient_records(p_patient_id, p_patient_name) f;

  IF ids IS NULL OR array_length(ids, 1) IS NULL THEN
    RETURN jsonb_build_object(
      'exported_at', now(),
      'matched', 0,
      'recordings', '[]'::jsonb,
      'letters', '[]'::jsonb
    );
  END IF;

  SELECT jsonb_build_object(
    'exported_at', now(),
    'requested_patient_id', p_patient_id,
    'requested_patient_name', p_patient_name,
    'matched', array_length(ids, 1),
    'recordings', COALESCE((
      SELECT jsonb_agg(to_jsonb(r)) FROM public.recordings r
      WHERE r.user_id = uid AND r.id = ANY(ids)), '[]'::jsonb),
    'letters', COALESCE((
      SELECT jsonb_agg(to_jsonb(l)) FROM public.letters l
      WHERE l.user_id = uid AND l.recording_id = ANY(ids)), '[]'::jsonb)
  ) INTO result;

  INSERT INTO public.processing_audit_log (user_id, action, detail)
  VALUES (uid, 'patient_data_exported', jsonb_build_object(
    'article', '15/20',
    'matched_records', array_length(ids, 1)
    -- Deliberately records the COUNT, not the patient identifier, so the audit
    -- trail does not itself become a register of patients.
  ));

  RETURN result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.gdpr_export_patient(text, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- 3. Erase — one patient's records, including audio (Art. 17)
--
-- p_expected_count guards against a race: the caller passes the number of
-- records the preview showed them, and the function refuses to proceed if the
-- data has changed since. Erasure is irreversible, so it must not act on a
-- different set than the one the user confirmed.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.gdpr_erase_patient(
  p_patient_id     text DEFAULT NULL,
  p_patient_name   text DEFAULT NULL,
  p_expected_count integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  uid             uuid := auth.uid();
  ids             uuid[];
  actual_count    integer;
  deleted_letters integer := 0;
  deleted_records integer := 0;
  deleted_objects integer := 0;
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT array_agg(f.recording_id)
  INTO ids
  FROM public.gdpr_find_patient_records(p_patient_id, p_patient_name) f;

  actual_count := COALESCE(array_length(ids, 1), 0);

  IF actual_count = 0 THEN
    RETURN jsonb_build_object('erased', false, 'matched', 0,
      'message', 'No records matched — nothing was deleted.');
  END IF;

  IF p_expected_count IS NOT NULL AND p_expected_count <> actual_count THEN
    RAISE EXCEPTION
      'Record count changed since preview (expected %, found %). Nothing deleted — please search again.',
      p_expected_count, actual_count;
  END IF;

  -- Audio objects first: if this fails we abort before destroying the rows
  -- that tell us which objects to remove.
  DELETE FROM storage.objects o
  USING public.recordings r
  WHERE r.id = ANY(ids)
    AND r.user_id = uid
    AND o.bucket_id = 'audio-recordings'
    AND o.name = r.audio_path
    AND r.audio_path <> '';
  GET DIAGNOSTICS deleted_objects = ROW_COUNT;

  DELETE FROM public.letters WHERE user_id = uid AND recording_id = ANY(ids);
  GET DIAGNOSTICS deleted_letters = ROW_COUNT;

  DELETE FROM public.recordings WHERE user_id = uid AND id = ANY(ids);
  GET DIAGNOSTICS deleted_records = ROW_COUNT;

  INSERT INTO public.processing_audit_log (user_id, action, detail)
  VALUES (uid, 'patient_data_erased', jsonb_build_object(
    'article', '17',
    'recordings_deleted', deleted_records,
    'letters_deleted', deleted_letters,
    'audio_objects_deleted', deleted_objects
  ));

  RETURN jsonb_build_object(
    'erased', true,
    'matched', actual_count,
    'recordings_deleted', deleted_records,
    'letters_deleted', deleted_letters,
    'audio_objects_deleted', deleted_objects
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.gdpr_erase_patient(text, text, integer) TO authenticated;
