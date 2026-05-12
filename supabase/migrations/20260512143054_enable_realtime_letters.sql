-- Enable Realtime for the letters table so the Record page can detect new letters
-- via DB events (works even if the client's fetch response is dropped).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'letters'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.letters;
  END IF;
END $$;
