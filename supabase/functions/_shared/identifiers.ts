/**
 * Keeping direct patient identifiers out of the AI provider's request.
 *
 * The letter prompt used to carry the patient's name and NHS number as a
 * header. The model does nothing with them except copy them into its output,
 * so sending them bought nothing and put two of the most directly identifying
 * fields we hold into a third party's request logs.
 *
 * Instead the prompt carries placeholder tokens, and the real values are
 * substituted into the generated letter here, on our own server, immediately
 * afterwards.
 *
 * ## Why this is not the "strip and reinstate" design that was rejected
 *
 * A general de-identify/re-identify pipeline has to *find* identifiers in
 * arbitrary text and later decide which patient each recovered placeholder
 * belongs to. That matching step is where wrong-patient association comes
 * from, and it is why the client declined to have one built.
 *
 * There is no matching step here. Substitution happens on a single letter, in
 * the same function call that produced it, using the same two variables that
 * are written to that letter's row a few lines later. There is no lookup, no
 * correlation, and no opportunity to pair one patient's identifiers with
 * another's letter — the values and the letter never leave each other's scope.
 *
 * ## What this does not achieve
 *
 * The transcript still goes to the provider, and a clinician may say the
 * patient's name aloud during the consultation. This is data minimisation,
 * not anonymisation, and must not be described as the latter: the remaining
 * clinical narrative is very often identifiable on its own.
 */

/** Tokens the model is asked to place where the identifiers belong. */
export const PATIENT_NAME_TOKEN = "[[PATIENT_NAME]]";
export const PATIENT_ID_TOKEN = "[[PATIENT_ID]]";

export interface PatientIdentifiers {
  name?: string | null;
  id?: string | null;
}

/**
 * The patient header as it is sent to the provider: tokens, never values.
 *
 * A token is emitted only when we actually hold that identifier, so the model
 * is not asked to invent a field we cannot fill in afterwards.
 */
export function placeholderPatientHeader(patient: PatientIdentifiers): string {
  return [
    // The name is sent as written, not tokenised. See WHY_THE_NAME_IS_SENT.
    patient.name ? `Patient Name: ${patient.name}` : null,
    patient.id ? `Patient ID / NHS Number: ${PATIENT_ID_TOKEN}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Why the name is sent while the NHS number is not.
 *
 * Tokenising the name assumed it only ever needed to appear in a header. Real
 * use showed otherwise: clinicians say the patient's name aloud, the
 * transcriber renders it phonetically — "Siobhan O'Brien" as "Shivawn
 * O'Brian" — and the literal replacement below cannot match a spelling it has
 * never seen. The misspelling therefore survived into the prompt and into the
 * letter body, beside a correctly substituted header. Two spellings of one
 * patient in one clinical letter.
 *
 * It also means the tokenisation was not achieving what it claimed in this
 * case. A recognisable near-miss of the name was already reaching the
 * provider whenever it was spoken; withholding the correct spelling bought
 * almost no privacy and cost correctness.
 *
 * So the name is sent, and the model is told to use that spelling throughout
 * and to correct phonetic variants of it in the transcript.
 *
 * The NHS number is different and stays tokenised. It is rarely spoken, a
 * transcription error makes it a different number rather than a misspelling
 * of the same one, and it is the identifier that most directly keys into
 * national records.
 */
export const WHY_THE_NAME_IS_SENT =
  "Transcription renders a spoken name phonetically, which literal replacement cannot match.";

/** Instruction appended to the system prompt so the identifiers come out right. */
export const PLACEHOLDER_INSTRUCTION =
  `The patient header gives the patient's name. Use exactly that spelling ` +
  `wherever the patient is named. The transcript may contain phonetic or ` +
  `misspelled renderings of it, because it was dictated aloud — correct ` +
  `those to the spelling in the header rather than reproducing them. ` +
  `The header also contains the placeholder token ${PATIENT_ID_TOKEN}. ` +
  `Reproduce it exactly as written wherever the patient's identifier ` +
  `belongs. Do not replace it, expand it, translate it, or invent a number.`;

/**
 * Puts the real identifiers back into a generated letter.
 *
 * Tokens for identifiers we do not hold are removed rather than left visible,
 * so a letter never ships with `[[PATIENT_ID]]` printed in it.
 *
 * Replacement is a literal string swap, not a regular expression: a patient
 * name containing regex metacharacters — O'Brien, or a hyphenated surname —
 * must not change how the replacement behaves.
 */
export function restorePatientIdentifiers(
  letter: string,
  patient: PatientIdentifiers,
): string {
  let out = letter;
  out = replaceAllLiteral(out, PATIENT_NAME_TOKEN, patient.name ?? "");
  out = replaceAllLiteral(out, PATIENT_ID_TOKEN, patient.id ?? "");
  return out;
}

function replaceAllLiteral(haystack: string, needle: string, value: string): string {
  if (!haystack.includes(needle)) return haystack;
  return haystack.split(needle).join(value);
}

/**
 * Replaces the identifiers we hold with their tokens.
 *
 * Needed when regenerating: the existing draft already has the real name and
 * NHS number substituted into it, so sending it back for refinement would
 * undo the minimisation.
 *
 * This is still not the rejected design. It is a literal replacement of two
 * values we just read from *this letter's own row* — not a search for
 * identifiers in arbitrary text, and not a later decision about whose they
 * were. The longer value is replaced first so a short identifier that happens
 * to be a substring of a longer one cannot corrupt it.
 */
export function redactPatientIdentifiers(
  text: string,
  patient: PatientIdentifiers,
): string {
  const replacements: [string, string][] = [];
  const id = (patient.id ?? "").trim();

  // The name is deliberately not replaced here. The model is given the
  // correct spelling in the header and asked to correct phonetic renderings
  // in the transcript, which it cannot do if we have blanked the only
  // occurrences it needs to see.
  //
  // Below three characters a value matches incidentally — a single digit —
  // and replacing it would mangle unrelated numbers.
  if (id.length >= 3) replacements.push([id, PATIENT_ID_TOKEN]);
  replacements.sort((a, b) => b[0].length - a[0].length);

  let out = text;
  for (const [value, token] of replacements) {
    out = replaceAllLiteral(out, value, token);
  }
  return out;
}

/**
 * True if an identifier that must not leave our systems appears in the text.
 *
 * Used to assert the property rather than trust it: the prompt is assembled
 * from several pieces and a later edit could reintroduce a value without
 * anyone noticing.
 *
 * The name is no longer one of these. It is sent deliberately, so asserting
 * its absence would now fail on every correct request — and a check that has
 * to be suppressed to pass is worse than no check, because the next person
 * suppresses it for the NHS number too.
 */
export function containsDirectIdentifier(
  text: string,
  patient: PatientIdentifiers,
): boolean {
  const id = (patient.id ?? "").trim();
  // A one- or two-digit value would match incidentally and is not worth
  // asserting on.
  return id.length >= 3 && text.includes(id);
}
