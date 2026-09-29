-- ===========================================================================
-- Idempotency for outbound clinical email
--
-- The first attempt at this relied on Azure's repeatability headers. Tested
-- against the live service, it did not hold: sending the same letter twice
-- produced two operation ids, and therefore two copies. Azure only treats a
-- request as a repeat when both Repeatability-Request-ID and
-- Repeatability-First-Sent match, and the timestamp was regenerated per call.
--
-- Rather than depend on a provider's interpretation for something that cannot
-- be undone once it happens, the guarantee is held here. A send is claimed
-- before it is attempted; a second attempt with the same key finds the claim
-- and returns the original outcome instead of sending again.
--
-- This also makes the property provider-independent, which matters given ACS
-- Email is itself a retiring product.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.email_sends (
  idempotency_key text PRIMARY KEY,
  user_id         uuid NOT NULL,
  letter_id       uuid,
  provider        text NOT NULL,
  recipients      integer NOT NULL DEFAULT 0,
  operation_id    text,
  status          text NOT NULL DEFAULT 'claimed',
  -- Reused on a retry so the provider's own repeatability headers can also
  -- match, rather than being regenerated and defeating them.
  first_sent_at   timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS email_sends_user_idx ON public.email_sends (user_id, first_sent_at DESC);
CREATE INDEX IF NOT EXISTS email_sends_letter_idx ON public.email_sends (letter_id);

ALTER TABLE public.email_sends ENABLE ROW LEVEL SECURITY;

-- No policies: reachable only through the SECURITY DEFINER functions below.
-- A caller able to delete its own rows could re-send a letter that the guard
-- had already accounted for.

-- ---------------------------------------------------------------------------
-- claim_email_send
--
-- Returns the existing row when this send has already been attempted, and
-- claims it otherwise. The INSERT ... ON CONFLICT DO NOTHING is what makes it
-- safe under concurrency: two simultaneous submissions cannot both find
-- nothing and both proceed, because only one insert can win.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_email_send(
  p_key        text,
  p_letter_id  uuid,
  p_provider   text,
  p_recipients integer
)
RETURNS TABLE (
  already_sent  boolean,
  operation_id  text,
  status        text,
  first_sent_at timestamptz
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_inserted boolean := false;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = 'insufficient_privilege';
  END IF;

  INSERT INTO public.email_sends (idempotency_key, user_id, letter_id, provider, recipients)
  VALUES (p_key, v_user, p_letter_id, p_provider, COALESCE(p_recipients, 0))
  ON CONFLICT (idempotency_key) DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  RETURN QUERY
  SELECT
    NOT v_inserted,
    e.operation_id,
    e.status,
    e.first_sent_at
  FROM public.email_sends e
  WHERE e.idempotency_key = p_key
    -- Scoped to the caller: one clinician's claim must not suppress another's
    -- send, even in the impossible case of a key collision.
    AND e.user_id = v_user;
END;
$$;

-- ---------------------------------------------------------------------------
-- record_email_send_result
--
-- Stores the outcome against a claim. A failed send is marked so, so that a
-- genuine retry after a failure is allowed rather than blocked by its own
-- claim — the guard exists to stop duplicate delivery, not to stop recovery.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_email_send_result(
  p_key          text,
  p_operation_id text,
  p_status       text
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user uuid := auth.uid();
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_status = 'failed' THEN
    -- Release the claim so the clinician can try again.
    DELETE FROM public.email_sends
     WHERE idempotency_key = p_key AND user_id = v_user;
    RETURN;
  END IF;

  UPDATE public.email_sends
     SET operation_id = COALESCE(p_operation_id, operation_id),
         status = p_status,
         updated_at = now()
   WHERE idempotency_key = p_key AND user_id = v_user;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_email_send(text, uuid, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_email_send_result(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_email_send(text, uuid, text, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_email_send_result(text, text, text) TO authenticated;

COMMENT ON TABLE public.email_sends IS
  'One row per logical outbound email. Prevents a retry or double submission '
  'from delivering a second copy of clinical correspondence, independently of '
  'whether the mail provider honours its own repeatability headers.';
