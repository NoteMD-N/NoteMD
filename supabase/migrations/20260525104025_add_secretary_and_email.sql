-- ============================================================
-- Secretary access (a secretary belongs to exactly one clinician)
-- ============================================================

-- Allow 'secretary' as a role (existing constraint only allowed clinician/admin)
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_role_check CHECK (role IN ('clinician', 'admin', 'doctor', 'secretary'));

-- A secretary's clinician (the clinician whose data they can access). NULL for clinicians.
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS clinician_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;

-- Email auto-send settings (per clinician)
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS auto_send_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS auto_send_recipients text[] NOT NULL DEFAULT '{}';

-- Helper: return the clinician_id the current user is a secretary for (SECURITY DEFINER avoids
-- RLS recursion on the profiles table).
CREATE OR REPLACE FUNCTION public.get_my_clinician_id()
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT clinician_id FROM public.profiles WHERE user_id = auth.uid();
$$;

-- Clinicians can see their assigned secretaries' profiles
CREATE POLICY "Clinicians can view their secretaries"
  ON public.profiles FOR SELECT
  USING (clinician_id = auth.uid());

-- Secretaries can read (but not modify) their clinician's recordings
CREATE POLICY "Secretaries can view their clinician's recordings"
  ON public.recordings FOR SELECT
  USING (user_id = public.get_my_clinician_id());

-- Secretaries can read their clinician's letters
CREATE POLICY "Secretaries can view their clinician's letters"
  ON public.letters FOR SELECT
  USING (user_id = public.get_my_clinician_id());

-- Secretaries can review their clinician's audio recordings in storage
CREATE POLICY "Secretaries can view their clinician's audio"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'audio-recordings'
    AND (storage.foldername(name))[1] = public.get_my_clinician_id()::text
  );
