# Consultation context — a new category of personal data

Added **9 October 2026**. Lets a clinician assemble background before a
consultation: notes they type or dictate, and documents they upload — previous
clinic letters, investigation results, referral correspondence.

This introduces a category of personal data the system did not previously hold,
and it is the most directly identifying data in the estate. A single previous
clinic letter typically carries name, NHS number, date of birth and address
together, where a transcript carries clinical narrative and little else. It
needs recording in the DPIA as a new category rather than as more of the same.

## Where the documents go

| | |
| --- | --- |
| Uploaded to | Supabase Storage, bucket `context-documents`, `eu-west-1` |
| Bucket visibility | **Private** |
| Access control | Row-level security plus a storage policy keyed on the owner's user id being the first path segment — the same rule as audio, so there is one access model to review rather than two |
| Summarised by | Azure OpenAI `gpt-4o`, resource `notemd-eu`, **France Central** |
| New sub-processor | **None.** The summariser is the deployment already used for letters |

Using the existing deployment was a deliberate choice. Optical character
recognition is commonly a separate vendor; routing it to the model already in
the register means no new data processing agreement, no new transfer
assessment, and no new region to evidence.

## Text extraction, and why the route is recorded

Two kinds of document arrive and they are handled differently:

- A **digital PDF** carries a text layer. The words are extracted in the
  browser, exactly as the author typed them. **The document is never uploaded
  as an image and the page content never leaves the device except as text.**
- A **scanned PDF** is photographs of paper, with no text to extract. Its pages
  are rendered in the browser and read by the vision model.

Which route was taken is stored against each document (`extraction_method`)
because the two have very different error profiles. A text layer is what the
author wrote. OCR is a model's reading of an image, and on a faxed, stamped,
annotated clinic letter it will get things wrong. Anyone relying on the summary
is entitled to know which applied, and the interface says so where the
clinician can see it.

A page must carry at least 100 characters before its text layer is believed.
Scanned documents often contain a stamp or a page number, and accepting those
as the document's content would summarise three words and look like success.

## Retention

Uploaded documents follow the **audio** retention period (default 30 days,
configurable per clinician), not the ten-year transcript period.

They are source material of the same kind as the recording, and more directly
identifying than it. Holding them for the period a transcript is kept would
turn a convenience feature into a second clinical archive that nobody asked
for and no one would remember existed.

`gdpr_purge_expired_context_documents()` deletes the stored file **and clears
the extracted text**. Clearing the text matters: the point of the purge is that
the previous clinic letter is gone, not that the PDF container is.

Deleting a consultation removes its context by foreign key. A right-to-erasure
request removes the storage objects as well as the rows — a request that left a
folder of the patient's previous correspondence behind would not be erasure.

## Clinical safety: why the summary was kept out of the letter, and what changed

**Original design (9 October).** The summary was shown to the clinician as
reference and was deliberately **not** an input to letter generation. The
reasoning: an error in a document summary entering a letter becomes established
clinical history. "Known hypertensive, on amlodipine 10mg" reads as fact, not as
something to verify, and no clinician opens the source PDF to check a sentence
that reads that way. It is the same failure mode as a hallucinated transcript
but harder to catch, because invented history is more plausible than invented
speech.

**Revision (14 October).** The client asked for a clinician-controlled choice.
That is now implemented as an explicit per-consultation opt-in, with the
following properties:

- **Default off.** A letter written from the consultation alone is the safe
  outcome, so it is what not deciding produces. A clinician who never notices
  the control gets exactly the behaviour that existed before it.
- **Stored against the consultation, not passed from the browser.** "Was this
  letter written with uploaded background in scope?" is a question that gets
  asked about a specific letter, sometimes long after it was signed. A request
  parameter would leave nothing to answer it with.
- **Recorded in the audit trail** as `context_used` against each generated
  letter.
- **Framed to the model when enabled.** The background is labelled as not part
  of the consultation, unverified, and possibly misread from scans. The model is
  instructed not to state anything from it as fact unless the transcript also
  supports it, and never to introduce a diagnosis, medication or dose that
  appears only there.
- **Refinement does not re-apply it.** Regenerating a letter works from the
  existing draft and does not pull context in again.

The separation and the gate are both asserted by automated test, including a
sweep over every edge function for reads of the context tables. A convention
whose reason has been forgotten gets wired together within the year by someone
reasonably thinking the letter would be better with more context in it.

## What the summariser is instructed to do

- Report only what the documents state; never infer, complete or add.
- Show uncertainty rather than resolve it — a scanned dose that could be 5mg or
  50mg is reported as unclear, because silently choosing one is how the wrong
  one ends up relied upon.
- Distinguish current medication from stopped medication.
- Write no plan, recommendation or management suggestion. It is background for
  a clinician about to see the patient, not an assessment, and anything phrased
  as one invites being acted on.

## Audit

`context.summarised` records the number of documents, whether OCR was used, the
length of the summary and the processing region. **It records that documents
were read, never what was in them.**

## Outstanding for the DPIA

1. Record uploaded clinical correspondence as a **new category of personal
   data**, distinct from transcripts, with its own retention period.
2. Record that the clinician may opt this material into letter generation, that
   it is off by default, and that the choice is logged per letter.
3. Confirm the retention period for uploaded documents is appropriate — 30 days
   is inherited from audio and has not been separately considered.
