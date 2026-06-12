-- Rename the headline presets and add a "Refined Letter" dictation preset
-- so the simpler-named options appear first in the Templates UI.

UPDATE public.templates
  SET name = 'Clinical Letter',
      description = 'Standard NHS clinic letter — consultant-level structure with comprehensive narrative.'
WHERE is_preset = true AND name = 'Enhanced Clinic Letter (Consultant-Level)';

UPDATE public.templates
  SET name = 'Refined Dictation Note',
      description = 'Polished structured clinical note from a dictation — preserves all content exactly as dictated.'
WHERE is_preset = true AND name = 'Enhanced Clinical Note (Dictation)';

-- Add a brand-new "Refined Letter" preset for dictation that takes a dictated
-- summary and produces a polished letter (not just a structured note).
INSERT INTO public.templates (user_id, name, description, prompt, mode, is_preset)
SELECT NULL,
       'Refined Letter',
       'Convert a dictation into a polished clinical letter ready to send.',
       $prompt$You are an expert UK clinical documentation assistant.
The clinician has dictated key clinical content. Your task is to convert it into a polished, well-structured clinical letter suitable for sending to GPs, other specialists, or the patient.

Preserve all clinical content exactly as dictated. Do not invent or infer additional clinical detail.

OUTPUT STRUCTURE

Dear Dr [GP Name] / [Recipient],

Opening paragraph: brief one-line summary of what the dictation covers (e.g. "I reviewed [patient] today in clinic.").

Then a flowing narrative body covering, where dictated:
- Presenting complaint and history.
- Examination findings.
- Investigations reviewed or requested.
- Diagnosis or impression.
- Management plan (medications, investigations, referrals, follow-up, safety-netting).

Use formal UK consultant-level correspondence style. British English. NHS terminology.

Closing:
Kind regards,
Dr [Doctor Name]
[Role / Specialty]

RULES
- Preserve clinical meaning exactly.
- Correct grammar, punctuation, spelling and formatting.
- Remove filler words and speech artefacts.
- Retain all clinically relevant information.
- Do not invent or infer information.
- Use British English and NHS terminology.
- Do not write in bold.
- Return only the letter text.$prompt$,
       'dictation',
       true
WHERE NOT EXISTS (
  SELECT 1 FROM public.templates WHERE is_preset = true AND name = 'Refined Letter'
);
