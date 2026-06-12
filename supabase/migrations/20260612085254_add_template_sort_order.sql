-- Add explicit sort order so headline presets always appear first regardless of name.
ALTER TABLE public.templates
  ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 100;

-- Set headline presets to sort first
UPDATE public.templates SET sort_order = 1
  WHERE is_preset = true AND name = 'Clinical Letter';

UPDATE public.templates SET sort_order = 1
  WHERE is_preset = true AND name = 'Refined Letter';

UPDATE public.templates SET sort_order = 2
  WHERE is_preset = true AND name = 'Refined Dictation Note';

UPDATE public.templates SET sort_order = 10
  WHERE is_preset = true AND name = 'Follow-up Letter';

UPDATE public.templates SET sort_order = 11
  WHERE is_preset = true AND name = 'Discharge Summary';

UPDATE public.templates SET sort_order = 12
  WHERE is_preset = true AND name = 'Referral Reply';

UPDATE public.templates SET sort_order = 20
  WHERE is_preset = true AND name = 'Dictation — SOAP Note';
