-- ===========================================================================
-- Consultation context
--
-- Background a clinician assembles *before* a consultation: notes they type
-- or dictate, and supporting documents they upload — previous clinic letters,
-- investigation results, referral correspondence.
--
-- Two design decisions are load-bearing and are enforced here rather than by
-- convention.
--
-- 1. **Context never reaches letter generation.** The summary produced from
--    these documents is reference material shown beside the transcript. It is
--    deliberately not an input to the letter. An error in a summary would
--    otherwise enter the letter as established clinical history — "known
--    hypertensive, on amlodipine 10mg" reads as fact, not as something to
--    verify, and no clinician opens the source PDF to check. That is the same
--    failure as a hallucinated transcript but harder to catch, because
--    invented history is more plausible than invented speech. The separation
--    is asserted by test, because a convention nobody remembers the reason
--    for is wired together within the year.
--
-- 2. **These documents are the most identifying data in the system.** A
--    previous clinic letter carries name, NHS number, date of birth and
--    address together. Audio has a retention policy; so must this, or
--    uploading a letter becomes a way of keeping identifiers long after the
--    recording they belonged to was purged. Both the retention sweep and the
--    erasure routine are extended below rather than left for later.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.consultation_contexts (
  id          uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Null until the consultation is recorded: context is assembled before the
  -- recording exists, and may be abandoned without one ever being made.
  recording_id uuid       REFERENCES public.recordings(id) ON DELETE CASCADE,
  -- What the clinician typed or dictated.
  notes       text,
  -- What the model extracted from the uploaded documents. Reference only.
  summary     text,
  summary_status text     NOT NULL DEFAULT 'none'
    CHECK (summary_status IN ('none', 'pending', 'ready', 'failed')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS consultation_contexts_user_idx
  ON public.consultation_contexts (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS consultation_contexts_recording_idx
  ON public.consultation_contexts (recording_id);

ALTER TABLE public.consultation_contexts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own context"
  ON public.consultation_contexts FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can create their own context"
  ON public.consultation_contexts FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update their own context"
  ON public.consultation_contexts FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete their own context"
  ON public.consultation_contexts FOR DELETE USING (auth.uid() = user_id);

CREATE TRIGGER update_consultation_contexts_updated_at
  BEFORE UPDATE ON public.consultation_contexts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ---------------------------------------------------------------------------
-- Uploaded documents
--
-- user_id is stored rather than reached through the context row. The storage
-- policies key on the first path segment being the owner's id, and a row that
-- carries its own owner can be checked the same way without a join — one
-- fewer place for a policy to be written subtly differently.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.context_documents (
  id          uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  context_id  uuid        NOT NULL REFERENCES public.consultation_contexts(id) ON DELETE CASCADE,
  user_id     uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  file_path   text        NOT NULL,
  file_name   text        NOT NULL,
  content_type text       NOT NULL,
  byte_size   integer     NOT NULL DEFAULT 0,
  -- Text pulled out of the document, by whichever route worked.
  extracted_text text,
  -- 'text-layer' when the PDF carried real text; 'ocr' when the pages had to
  -- be read as images. Recorded because the two have very different error
  -- profiles and a reader of the summary deserves to know which applied.
  extraction_method text
    CHECK (extraction_method IS NULL OR extraction_method IN ('text-layer', 'ocr', 'none')),
  page_count  integer,
  purged_at   timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS context_documents_context_idx
  ON public.context_documents (context_id);
CREATE INDEX IF NOT EXISTS context_documents_user_idx
  ON public.context_documents (user_id, created_at DESC);

ALTER TABLE public.context_documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own context documents"
  ON public.context_documents FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can create their own context documents"
  ON public.context_documents FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update their own context documents"
  ON public.context_documents FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete their own context documents"
  ON public.context_documents FOR DELETE USING (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Storage
--
-- Private bucket, owner-scoped by first path segment — the same shape as
-- audio-recordings, so there is one access rule to understand rather than two.
-- ---------------------------------------------------------------------------

INSERT INTO storage.buckets (id, name, public)
VALUES ('context-documents', 'context-documents', false)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Users can upload their own context documents"
  ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'context-documents' AND auth.uid()::text = (storage.foldername(name))[1]);
CREATE POLICY "Users can read their own context documents"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'context-documents' AND auth.uid()::text = (storage.foldername(name))[1]);
CREATE POLICY "Users can delete their own context documents"
  ON storage.objects FOR DELETE
  USING (bucket_id = 'context-documents' AND auth.uid()::text = (storage.foldername(name))[1]);

-- ---------------------------------------------------------------------------
-- Retention
--
-- Uploaded documents follow the audio retention period, not the transcript
-- one. They are source material of the same kind as the recording — and more
-- directly identifying than it — so keeping them for the ten years a
-- transcript is held would turn a convenience feature into a second clinical
-- archive nobody asked for.
--
-- The extracted text goes with the file. Keeping it would defeat the purge:
-- the point is that the previous clinic letter is gone, not that the PDF is.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.gdpr_purge_expired_context_documents()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  purged integer := 0;
  rec    record;
BEGIN
  FOR rec IN
    SELECT d.id, d.file_path
    FROM public.context_documents d
    JOIN public.profiles p ON p.user_id = d.user_id
    WHERE d.file_path IS NOT NULL
      AND d.file_path <> ''
      AND d.purged_at IS NULL
      AND d.created_at < now() - make_interval(days => p.audio_retention_days)
  LOOP
    DELETE FROM storage.objects
    WHERE bucket_id = 'context-documents'
      AND name = rec.file_path;

    UPDATE public.context_documents
    SET purged_at = now(),
        file_path = '',
        extracted_text = NULL
    WHERE id = rec.id;

    purged := purged + 1;
  END LOOP;

  RETURN purged;
END;
$$;

REVOKE ALL ON FUNCTION public.gdpr_purge_expired_context_documents() FROM PUBLIC;

COMMENT ON FUNCTION public.gdpr_purge_expired_context_documents IS
  'Deletes uploaded context documents and their extracted text once the '
  'owner''s audio retention period has elapsed. They are source material of '
  'the same kind as the recording and more directly identifying, so they '
  'follow the audio period rather than the transcript one.';

-- ---------------------------------------------------------------------------
-- Erasure
--
-- A right-to-erasure request that left a folder of the patient's previous
-- clinic letters behind would not be erasure.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.gdpr_erase_context_documents(uid uuid)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  deleted integer := 0;
BEGIN
  DELETE FROM storage.objects
  WHERE bucket_id = 'context-documents'
    AND (storage.foldername(name))[1] = uid::text;

  DELETE FROM public.context_documents WHERE user_id = uid;
  GET DIAGNOSTICS deleted = ROW_COUNT;

  DELETE FROM public.consultation_contexts WHERE user_id = uid;

  RETURN deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.gdpr_erase_context_documents(uuid) FROM PUBLIC;

COMMENT ON TABLE public.consultation_contexts IS
  'Background assembled before a consultation. The summary is reference '
  'material shown beside the transcript and is deliberately NOT an input to '
  'letter generation: an error in it would otherwise enter the letter as '
  'established clinical history, which is harder to catch than an invented '
  'transcript because it reads as fact.';
