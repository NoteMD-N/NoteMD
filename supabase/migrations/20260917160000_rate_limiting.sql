-- ===========================================================================
-- Rate limiting for sensitive endpoints
--
-- Counters live in Postgres rather than in a Redis service. Edge functions
-- are stateless and scale horizontally, so an in-memory counter would limit
-- nothing; but adding Upstash or similar would introduce another processor,
-- another region to evidence and another DPA, for a counter. The database is
-- already in eu-west-1 and already holds the data being protected.
--
-- Scope: the authenticated endpoints that cost money or send correspondence —
-- transcription credential minting, AI generation, and email. Sign-in and
-- password-recovery brute force is handled by GoTrue's own rate limits
-- (Dashboard -> Authentication -> Rate Limits), which apply before a session
-- exists and therefore before anything here could identify a caller.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.rate_limit_counters (
  bucket       text        NOT NULL,
  subject      uuid        NOT NULL,
  window_start timestamptz NOT NULL,
  count        integer     NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, subject, window_start)
);

-- Used by the sweep inside check_rate_limit.
CREATE INDEX IF NOT EXISTS rate_limit_counters_window_idx
  ON public.rate_limit_counters (window_start);

ALTER TABLE public.rate_limit_counters ENABLE ROW LEVEL SECURITY;

-- No policies at all: the table is reached only through the SECURITY DEFINER
-- function below. A caller that could read its own counters could infer the
-- limits; a caller that could write them could reset them.

-- ---------------------------------------------------------------------------
-- check_rate_limit
--
-- Atomically records one use and reports whether it was within the limit. The
-- INSERT ... ON CONFLICT DO UPDATE is what makes it safe under concurrency:
-- two simultaneous requests cannot both read "count = limit - 1" and both
-- proceed, because the increment happens inside a single statement.
--
-- The subject is always auth.uid(). It is never a parameter, so a caller
-- cannot consume someone else's allowance or claim a fresh one.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.check_rate_limit(
  p_bucket         text,
  p_limit          integer,
  p_window_seconds integer
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_subject uuid := auth.uid();
  v_window  timestamptz;
  v_count   integer;
BEGIN
  IF v_subject IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_limit < 1 OR p_window_seconds < 1 THEN
    RAISE EXCEPTION 'invalid rate limit configuration';
  END IF;

  -- Fixed windows rather than a sliding log: one row per subject per window
  -- instead of one row per request, which matters when the limit is a few
  -- hundred transcription segments an hour.
  v_window := to_timestamp(
    floor(extract(epoch FROM clock_timestamp()) / p_window_seconds) * p_window_seconds
  );

  INSERT INTO public.rate_limit_counters AS c (bucket, subject, window_start, count)
  VALUES (p_bucket, v_subject, v_window, 1)
  ON CONFLICT (bucket, subject, window_start)
  DO UPDATE SET count = c.count + 1
  RETURNING c.count INTO v_count;

  -- Opportunistic sweep. Cheap, bounded, and avoids needing a scheduled job
  -- for what is a small table.
  IF random() < 0.01 THEN
    DELETE FROM public.rate_limit_counters
     WHERE window_start < clock_timestamp() - interval '1 day';
  END IF;

  RETURN jsonb_build_object(
    'allowed',   v_count <= p_limit,
    'count',     v_count,
    'limit',     p_limit,
    'remaining', greatest(0, p_limit - v_count),
    'reset_at',  v_window + make_interval(secs => p_window_seconds)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.check_rate_limit(text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_rate_limit(text, integer, integer) TO authenticated;

COMMENT ON FUNCTION public.check_rate_limit IS
  'Records one use of a rate-limited endpoint and reports whether it was '
  'within the limit. The subject is taken from auth.uid() and is never a '
  'parameter, so an allowance cannot be spoofed or reset by the caller.';
