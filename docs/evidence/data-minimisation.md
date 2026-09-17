# Data minimisation — what reaches each external provider

Implemented 17 September 2026. Enforced by
`src/test/identifier-minimisation.test.ts`.

## What changed

The letter prompt previously carried the patient's name and NHS number as a
header:

    Patient Name: Jane O'Brien-Smith
    Patient ID / NHS Number: 485 777 3456

The model does nothing with these except copy them into its output, so sending
them achieved nothing and placed two of the most directly identifying fields
we hold into a third party's request logs.

The prompt now carries tokens — `[[PATIENT_NAME]]` and `[[PATIENT_ID]]` — and
the real values are substituted into the generated letter on our own server
immediately afterwards.

Regeneration does the same in reverse first: the existing draft already has
the real values in it, so sending it back for refinement would have undone the
minimisation on the very next request.

## Why this is not the design that was declined

The client declined a general "strip and reinstate" identifier system on the
grounds that it would introduce new code and a clinical-safety risk. That was
the right call: such a pipeline has to *find* identifiers in arbitrary text and
later decide which patient each recovered placeholder belonged to, and that
matching step is where wrong-patient association comes from.

There is no matching step here:

- Substitution happens on a single letter, inside the same function call that
  produced it.
- The values come from the same two variables that are written to that
  letter's own row a few lines later.
- There is no lookup, no correlation and no cross-record state.

A letter therefore cannot acquire another patient's identifiers, and a test
asserts that directly.

Replacement is a literal string operation rather than a regular expression, so
a name containing metacharacters — `O'Brien-Smith`, `Anne-Marie [Jr]`,
`A+B Patel` — round-trips unchanged. Values shorter than three characters are
left alone, because an initial or a single digit matches incidentally and
replacing it would corrupt unrelated words.

## Guard

Before either function sends a request, the fully assembled prompt is checked
for the identifiers we hold. The prompt is built from a safety clause, a
template the clinician may have written themselves, and the transcript — so
the check covers the case where a later edit, or a clinician's own template,
reintroduces a value. If one is found the request is refused rather than sent,
and the refusal is audited.

## What still reaches each provider

| Provider | Receives | Direct identifiers |
| --- | --- | --- |
| Deepgram (EU, `mip_opt_out=true`) | Consultation audio | None sent by NoteMD. Names spoken aloud are inherent to the audio. |
| OpenAI — transcription | Consultation audio | Same. |
| OpenAI — letter generation | Transcript, template, placeholder header | **None.** Name and NHS number replaced by tokens. |
| OpenAI — regeneration | Redacted transcript, redacted draft, instructions | **None.** |

## What this does not achieve

This is **data minimisation, not anonymisation**, and must not be described as
the latter in the DPIA.

The transcript still reaches the provider, and a clinician may say the
patient's name aloud during a consultation. The remaining clinical narrative
is very often identifiable on its own. What has changed is that the structured,
directly identifying fields — the name as recorded, and the NHS number — are no
longer transmitted, which reduces the consequence of a provider-side
compromise without introducing a wrong-patient failure mode.

## Observability

Each generation records `identifier_tokens_expected` and
`identifier_tokens_restored` in the audit trail. If a model paraphrases a token
instead of reproducing it, the letter comes back without the header. That is a
degradation rather than a safety problem — no wrong identifier can appear, and
a clinician reviews every letter before it can be sent — but it is visible in
the audit log rather than silent.
