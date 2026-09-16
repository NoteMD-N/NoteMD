-- ===========================================================================
-- Expanded clinical audit trail
--
-- Establishes, for every significant event:
--
--   who (actor) -> did what (action) -> against which record (resource) ->
--   when (created_at) -> with what result (outcome)
--
-- Three properties matter for NHS assurance, and none of them held before:
--
--   1. The actor and the subject are separate. A secretary acting on their
--      clinician's record must be attributable to the secretary, while the
--      record still belongs to the clinician. One user_id column cannot
--      express that.
--   2. The log is append-only against *every* role, not only against the
--      client. Writes arrive through the service role, which bypasses RLS,
--      so the previous "no UPDATE/DELETE policy" approach left the log
--      editable by the same credential that writes it.
--   3. Clinical content never enters the log. This is asserted by the
--      database rather than by convention, so it cannot regress silently.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Actor, outcome and request context
-- ---------------------------------------------------------------------------
ALTER TABLE public.processing_audit_log
  ADD COLUMN IF NOT EXISTS actor_user_id uuid,
  ADD COLUMN IF NOT EXISTS actor_role    text,
  ADD COLUMN IF NOT EXISTS outcome       text NOT NULL DEFAULT 'success';

-- Existing rows were all self-initiated, so the actor is the subject.
UPDATE public.processing_audit_log
   SET actor_user_id = user_id
 WHERE actor_user_id IS NULL;

ALTER TABLE public.processing_audit_log
  ALTER COLUMN actor_user_id SET NOT NULL;

ALTER TABLE public.processing_audit_log
  DROP CONSTRAINT IF EXISTS processing_audit_log_outcome_check;
ALTER TABLE public.processing_audit_log
  ADD CONSTRAINT processing_audit_log_outcome_check
  CHECK (outcome IN ('success', 'failure', 'denied'));

-- 'denied' records an attempt that access control refused. Those are the rows
-- an investigation cares about most, so they are indexed separately.
CREATE INDEX IF NOT EXISTS processing_audit_log_actor_created_idx
  ON public.processing_audit_log (actor_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS processing_audit_log_denied_idx
  ON public.processing_audit_log (created_at DESC)
  WHERE outcome = 'denied';

CREATE INDEX IF NOT EXISTS processing_audit_log_resource_idx
  ON public.processing_audit_log (resource, resource_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 2. Clinical content must never reach the audit log
--
-- The audit trail records that a letter was generated, not what it said.
-- Enforced as a constraint so a future call site cannot quietly start
-- copying transcripts into `detail`.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.audit_detail_is_clean(d jsonb)
RETURNS boolean
LANGUAGE plpgsql IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  k text;
  banned CONSTANT text[] := ARRAY[
    'transcript', 'transcript_text', 'raw_transcript', 'letter', 'letter_content',
    'content', 'body', 'text', 'audio', 'audio_data', 'prompt', 'completion',
    'message', 'messages', 'patient_name', 'patient_id', 'nhs_number', 'dob',
    'date_of_birth', 'address', 'phone', 'telephone', 'email'
  ];
BEGIN
  IF d IS NULL THEN
    RETURN true;
  END IF;

  -- A large payload is clinical content by another name.
  IF length(d::text) > 4096 THEN
    RETURN false;
  END IF;

  FOR k IN SELECT jsonb_object_keys(d) LOOP
    IF lower(k) = ANY (banned) THEN
      RETURN false;
    END IF;
  END LOOP;

  RETURN true;
EXCEPTION
  -- jsonb_object_keys raises if `d` is not an object; a scalar or array
  -- detail is not a shape we write, so refuse it.
  WHEN others THEN RETURN false;
END;
$$;

ALTER TABLE public.processing_audit_log
  DROP CONSTRAINT IF EXISTS processing_audit_log_detail_clean;
ALTER TABLE public.processing_audit_log
  ADD CONSTRAINT processing_audit_log_detail_clean
  CHECK (public.audit_detail_is_clean(detail));

-- ---------------------------------------------------------------------------
-- 3. Append-only against every role
--
-- RLS does not apply to the service role, so the rule is enforced by a
-- trigger instead. Retention pruning, when it is introduced, must drop
-- whole partitions or run with session_replication_role = 'replica'.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.processing_audit_log_is_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'processing_audit_log is append-only (attempted %)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS processing_audit_log_no_update ON public.processing_audit_log;
CREATE TRIGGER processing_audit_log_no_update
  BEFORE UPDATE OR DELETE ON public.processing_audit_log
  FOR EACH ROW EXECUTE FUNCTION public.processing_audit_log_is_append_only();

REVOKE UPDATE, DELETE, TRUNCATE ON public.processing_audit_log FROM anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Read access
--
-- The subject of the record reads their own audit trail. An actor reads
-- their own actions, so a secretary can see what they themselves did without
-- gaining sight of the clinician's wider log.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "own audit rows readable" ON public.processing_audit_log;
CREATE POLICY "own audit rows readable"
  ON public.processing_audit_log FOR SELECT
  USING (auth.uid() = user_id OR auth.uid() = actor_user_id);

-- ---------------------------------------------------------------------------
-- 5. Controlled write path for the browser
--
-- The client has no INSERT policy and must not get one: a client that can
-- write arbitrary rows can forge attribution. This function is the only
-- route, and it derives the actor from the session rather than the caller's
-- arguments. The subject is validated: a caller may log against their own
-- records, or against their clinician's records if they are that clinician's
-- secretary. Anything else is recorded as a denied attempt rather than
-- rejected silently.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.log_audit_event(
  p_action      text,
  p_resource    text DEFAULT NULL,
  p_resource_id uuid DEFAULT NULL,
  p_subject_id  uuid DEFAULT NULL,
  p_outcome     text DEFAULT 'success',
  p_detail      jsonb DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor     uuid := auth.uid();
  v_role      text;
  v_clinician uuid;
  v_subject   uuid;
  v_outcome   text := p_outcome;
  v_id        uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT role, clinician_id INTO v_role, v_clinician
    FROM public.profiles WHERE user_id = v_actor;

  v_subject := COALESCE(p_subject_id, v_actor);

  -- Attribution rule: you may write against yourself, or against the
  -- clinician you are assigned to.
  IF v_subject <> v_actor AND (v_clinician IS NULL OR v_subject <> v_clinician) THEN
    v_subject := v_actor;
    v_outcome := 'denied';
  END IF;

  IF v_outcome NOT IN ('success', 'failure', 'denied') THEN
    v_outcome := 'failure';
  END IF;

  INSERT INTO public.processing_audit_log
    (user_id, actor_user_id, actor_role, action, resource, resource_id, outcome, detail)
  VALUES
    (v_subject, v_actor, v_role, p_action, p_resource, p_resource_id, v_outcome,
     CASE WHEN public.audit_detail_is_clean(p_detail) THEN p_detail ELSE NULL END)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.log_audit_event(text, text, uuid, uuid, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.log_audit_event(text, text, uuid, uuid, text, jsonb) TO authenticated;

COMMENT ON FUNCTION public.log_audit_event IS
  'Sole client-facing write path into processing_audit_log. Derives the actor '
  'from auth.uid() so attribution cannot be forged, and drops any detail '
  'payload that would carry clinical content.';
