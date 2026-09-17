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
    patient.name ? `Patient Name: ${PATIENT_NAME_TOKEN}` : null,
    patient.id ? `Patient ID / NHS Number: ${PATIENT_ID_TOKEN}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Instruction appended to the system prompt so the tokens survive verbatim. */
export const PLACEHOLDER_INSTRUCTION =
  `The patient header contains placeholder tokens such as ${PATIENT_NAME_TOKEN} ` +
  `and ${PATIENT_ID_TOKEN}. Reproduce them exactly as written wherever the ` +
  `patient's name or identifier belongs. Do not replace them, expand them, ` +
  `translate them, or invent a name.`;

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
  const name = (patient.name ?? "").trim();
  const id = (patient.id ?? "").trim();

  // Below three characters a value matches incidentally — an initial, or a
  // single digit — and replacing it would mangle unrelated words.
  if (name.length >= 3) replacements.push([name, PATIENT_NAME_TOKEN]);
  if (id.length >= 3) replacements.push([id, PATIENT_ID_TOKEN]);
  replacements.sort((a, b) => b[0].length - a[0].length);

  let out = text;
  for (const [value, token] of replacements) {
    out = replaceAllLiteral(out, value, token);
  }
  return out;
}

/**
 * True if any identifier we hold appears in the text sent to the provider.
 *
 * Used to assert the property rather than trust it: the prompt is assembled
 * from several pieces and a later edit could reintroduce a value without
 * anyone noticing.
 */
export function containsDirectIdentifier(
  text: string,
  patient: PatientIdentifiers,
): boolean {
  const name = (patient.name ?? "").trim();
  const id = (patient.id ?? "").trim();
  // Very short values would match incidentally — an initial, or a one-digit
  // identifier — and are not worth asserting on.
  if (name.length >= 3 && text.includes(name)) return true;
  if (id.length >= 3 && text.includes(id)) return true;
  return false;
}
