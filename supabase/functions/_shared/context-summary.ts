/**
 * How uploaded background documents are summarised.
 *
 * Kept separate from the letter prompts so the two cannot drift into each
 * other, and so the separation this feature depends on is visible in the file
 * layout: nothing in `generate-letter` imports anything from here.
 */

/**
 * Upper bound on extracted text sent in one request.
 *
 * Roughly thirty pages of clinic correspondence. A clinician who uploads a
 * complete case file should get a summary of the beginning of it rather than
 * a provider error, and the truncation is reported so they know.
 */
export const MAX_CONTEXT_CHARS = 120_000;

/**
 * The summariser's instructions.
 *
 * Three things are being guarded against, and each has a line here:
 *
 *   1. **Invention.** This is a summary of documents, so anything not in them
 *      is wrong by definition. The failure is not a plausible-looking error
 *      but a confident one: a drug that was stopped reported as current reads
 *      exactly like a drug that is current.
 *
 *   2. **Flattening uncertainty.** Scanned documents are read from images and
 *      will contain misreads. A dose that could be 5mg or 50mg must be shown
 *      as uncertain rather than resolved by the model's judgement, because
 *      resolving it silently is how the wrong one ends up relied upon.
 *
 *   3. **Sounding like clinical advice.** This is background for a clinician
 *      who is about to see the patient. It is not an assessment, and anything
 *      phrased as one invites being acted on.
 */
export const CONTEXT_SUMMARY_PROMPT = `You summarise background documents a UK clinician has uploaded before a consultation — previous clinic letters, investigation results, referral correspondence.

Your output is REFERENCE MATERIAL for the clinician to read before seeing the patient. It is not a clinical assessment, it is not advice, and it is not used to write any letter.

Rules:

- Report only what the documents state. Never infer, complete, or add anything — not a diagnosis, not a drug, not a date, not a dose.
- If something is unclear or unreadable, say so in place of a value. Write "dose unclear (could be 5mg or 50mg)" rather than choosing one. Several of these documents are scans read from images and will contain misreadings; flagging them is more useful than resolving them.
- Attribute facts to their source document where it matters, e.g. "(cardiology letter, 12 March)".
- Distinguish current from historical. A medication that was stopped must not be listed as current.
- Keep British English and standard UK clinical abbreviations.
- Do not write a plan, a recommendation, or a management suggestion of any kind.

Structure the summary under whichever of these headings the documents support, omitting any with nothing to report:

**Active problems**
**Current medications**
**Relevant past history**
**Recent investigations**
**Outstanding actions noted in correspondence**
**Unclear or unreadable in the source**

Be concise. A clinician will read this in under a minute before a consultation.`;
