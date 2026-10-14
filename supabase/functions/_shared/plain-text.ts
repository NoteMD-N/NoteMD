/**
 * Removing Markdown from clinical text.
 *
 * The letter prompt tells the model not to use bold, in three separate places,
 * and it does anyway. Instructions are a request; this is the control.
 *
 * Stripping rather than rendering is the right answer for a letter
 * specifically. It is edited in a plain textarea, copied into electronic
 * record systems, emailed and printed — and in every one of those a `**`
 * is noise the clinician has to delete by hand. There is nowhere in that
 * chain where Markdown means anything.
 *
 * The rules are deliberately narrow. A clinical letter can legitimately
 * contain an asterisk (a footnote marker, a units note), a hash (a fracture
 * noted as `# NOF`), and a hyphen at the start of a line (a list the
 * clinician dictated). Only paired emphasis and genuine heading syntax are
 * touched; anything that is merely asterisk-shaped is left alone.
 */

/**
 * Strips Markdown emphasis and heading syntax, leaving the words.
 *
 * `**Active problems**` becomes `Active problems`. `# NOF` is left exactly as
 * it is, because in a clinical letter that is a fractured neck of femur and
 * not a level-one heading.
 */
export function stripMarkdown(text: string): string {
  if (!text) return text;

  let out = text;

  // Bold and italic, including the triple-marker combination. Paired only:
  // the content must not start or end with whitespace, which is what
  // separates `**bold**` from an asterisk used as a footnote marker.
  out = out.replace(/\*\*\*(?=\S)([\s\S]*?)(?<=\S)\*\*\*/g, "$1");
  out = out.replace(/\*\*(?=\S)([\s\S]*?)(?<=\S)\*\*/g, "$1");
  out = out.replace(/(?<![*\w])\*(?=\S)([^*\n]*?)(?<=\S)\*(?![*\w])/g, "$1");

  // Underscore emphasis, bounded by non-word characters so that
  // snake_case_identifiers and `U&E_results` survive.
  out = out.replace(/(?<![\w_])__(?=\S)([\s\S]*?)(?<=\S)__(?![\w_])/g, "$1");
  out = out.replace(/(?<![\w_])_(?=\S)([^_\n]*?)(?<=\S)_(?![\w_])/g, "$1");

  // ATX headings — but only where a space follows the hashes and the line is
  // a plausible heading. "# NOF" stays: one hash, short, and clinical.
  out = out.replace(/^(#{1,6})\s+(?=\S)/gm, (match, hashes: string, offset: number, whole: string) => {
    // A single hash followed by an abbreviation is a clinical shorthand, not
    // a heading. More than one hash is unambiguous Markdown.
    if (hashes.length > 1) return "";
    const lineEnd = whole.indexOf("\n", offset);
    const line = whole.slice(offset + match.length, lineEnd === -1 ? undefined : lineEnd);
    // "# NOF", "# wrist" — short, no sentence punctuation: clinical.
    return /^[A-Za-z/]{1,12}\s*$/.test(line) ? match : "";
  });

  // Fenced code blocks have no place in a clinical letter, and a model that
  // emits one has wrapped the letter in it.
  out = out.replace(/^```[a-zA-Z]*\s*$/gm, "");

  // Bullet markers written as asterisks become hyphens, which read naturally
  // in a letter. A hyphen bullet is already fine and is left alone.
  out = out.replace(/^(\s*)\*\s+(?=\S)/gm, "$1- ");

  // Link syntax: keep the words, drop the target. A URL in a clinical letter
  // belongs written out, not hidden behind text.
  out = out.replace(/\[([^\]\n]+)\]\((https?:[^)\s]+)\)/g, "$1 ($2)");

  return out;
}

/**
 * True when text still carries Markdown we would have stripped.
 *
 * Used to assert the property rather than trust it — the letter is assembled
 * from several pieces and a later edit could reintroduce it.
 */
export function containsMarkdown(text: string): boolean {
  return stripMarkdown(text) !== text;
}
