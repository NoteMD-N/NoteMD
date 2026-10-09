// @vitest-environment node
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PATIENT_ID_TOKEN,
  PATIENT_NAME_TOKEN,
  PLACEHOLDER_INSTRUCTION,
  containsDirectIdentifier,
  placeholderPatientHeader,
  redactPatientIdentifiers,
  restorePatientIdentifiers,
} from "../../supabase/functions/_shared/identifiers.ts";

/**
 * Direct identifiers should not reach the AI provider.
 *
 * The client declined a general de-identify/re-identify pipeline, and was
 * right to: that design has to find identifiers in arbitrary text and later
 * decide whose each recovered placeholder was, which is where wrong-patient
 * association comes from.
 *
 * What is implemented has no matching step — substitution happens on one
 * letter, in the scope that produced it, from the same two variables written
 * to that letter's row. The tests below are mostly about proving that the
 * round trip is lossless and that a name with awkward characters cannot
 * corrupt it.
 */

const ROOT = join(__dirname, "../..");
const generateLetter = readFileSync(
  join(ROOT, "supabase/functions/generate-letter/index.ts"),
  "utf8",
);
const regenerateLetter = readFileSync(
  join(ROOT, "supabase/functions/regenerate-letter/index.ts"),
  "utf8",
);

const PATIENT = { name: "Jane O'Brien-Smith", id: "485 777 3456" };

describe("what is sent to the provider", () => {
  it("sends the name and a token for the NHS number", () => {
    // The name is sent so the model can spell it correctly. Dictated aloud it
    // arrives phonetically — "Siobhan O'Brien" as "Shivawn O'Brian" — and a
    // literal replacement cannot match a spelling it has never seen, so the
    // misspelling reached the letter beside a correctly substituted header.
    const header = placeholderPatientHeader(PATIENT);
    expect(header).toContain("Jane O'Brien-Smith");
    expect(header).toContain(PATIENT_ID_TOKEN);
    expect(header).not.toContain("485 777 3456");
  });

  it("omits the identifier line when we do not hold one", () => {
    // Asking the model for a field we cannot fill afterwards would leave a
    // visible placeholder in the finished letter.
    const header = placeholderPatientHeader({ name: "Jane Smith", id: null });
    expect(header).toContain("Jane Smith");
    expect(header).not.toContain(PATIENT_ID_TOKEN);
  });

  it("strips the NHS number from an existing draft but keeps the name", () => {
    // Regeneration sends the current letter back. The number must not go out
    // again; the name must stay, or the refinement loses the spelling it was
    // given in the first place.
    const draft = `Dear Colleague,\n\nRe: ${PATIENT.name} (${PATIENT.id})\n\nSeen today.`;
    const out = redactPatientIdentifiers(draft, PATIENT);
    expect(out).toContain("Jane O'Brien-Smith");
    expect(out).not.toContain("485 777 3456");
    expect(out).toContain(PATIENT_ID_TOKEN);
    expect(out).toContain("Seen today.");
  });

  it("tells the model to correct phonetic spellings of the name", () => {
    // Without this the model reproduces what the transcript says, which is
    // the whole defect.
    expect(PLACEHOLDER_INSTRUCTION).toMatch(/phonetic|misspel/i);
    expect(PLACEHOLDER_INSTRUCTION).toMatch(/exactly that spelling/i);
  });

  it("leaves very short values alone", () => {
    // A one or two character identifier matches incidentally and replacing it
    // would mangle unrelated words.
    const out = redactPatientIdentifiers("The patient is at home.", { name: "at", id: "5" });
    expect(out).toBe("The patient is at home.");
  });
});

describe("the round trip is lossless", () => {
  it("restores exactly what was removed", () => {
    const original = `Re: ${PATIENT.name} (${PATIENT.id})\n\nClinical detail.`;
    const roundTripped = restorePatientIdentifiers(
      redactPatientIdentifiers(original, PATIENT),
      PATIENT,
    );
    expect(roundTripped).toBe(original);
  });

  it("handles names containing regular-expression metacharacters", () => {
    // O'Brien-Smith, and worse. Replacement must be literal, not a pattern.
    for (const name of ["O'Brien-Smith", "D. (Danny) Smith", "Anne-Marie [Jr]", "A+B Patel"]) {
      const patient = { name, id: "NHS.123*456" };
      const original = `Re: ${name} (${patient.id})`;
      expect(
        restorePatientIdentifiers(redactPatientIdentifiers(original, patient), patient),
      ).toBe(original);
    }
  });

  it("replaces every occurrence of the identifier, not just the first", () => {
    const original = `NHS ${PATIENT.id} seen. Confirmed ${PATIENT.id}. Filed under ${PATIENT.id}.`;
    const redacted = redactPatientIdentifiers(original, PATIENT);
    expect(redacted).not.toContain("485 777 3456");
    expect(restorePatientIdentifiers(redacted, PATIENT)).toBe(original);
  });

  it("does not leave a visible token when an identifier is missing", () => {
    // The model may emit a token we cannot fill; the letter must not ship
    // with "[[PATIENT_ID]]" printed in it.
    const out = restorePatientIdentifiers(
      `Re: ${PATIENT_NAME_TOKEN} (${PATIENT_ID_TOKEN})`,
      { name: "Jane Smith", id: null },
    );
    expect(out).toBe("Re: Jane Smith ()");
    expect(out).not.toContain("[[");
  });

  it("cannot pair one patient's identifiers with another's letter", () => {
    // Substitution takes its values from an argument, not a lookup. Given B's
    // letter and B's identifiers, A's details cannot appear.
    const a = { name: "Alice Adams", id: "111 111 1111" };
    const b = { name: "Bob Barker", id: "222 222 2222" };
    const bLetter = restorePatientIdentifiers(`Re: ${PATIENT_NAME_TOKEN} (${PATIENT_ID_TOKEN})`, b);
    expect(bLetter).toContain("Bob Barker");
    expect(bLetter).not.toContain(a.name);
    expect(bLetter).not.toContain(a.id);
  });
});

describe("the leak check", () => {
  it("detects an NHS number that reached the prompt", () => {
    expect(containsDirectIdentifier(`NHS ${PATIENT.id}`, PATIENT)).toBe(true);
  });

  it("does not flag the name, which is sent on purpose", () => {
    // A check that has to be suppressed to pass is worse than no check: the
    // next person suppresses it for the NHS number too.
    expect(containsDirectIdentifier(`Patient: ${PATIENT.name}`, PATIENT)).toBe(false);
    expect(containsDirectIdentifier(placeholderPatientHeader(PATIENT), PATIENT)).toBe(false);
  });

  it("ignores short values that would match incidentally", () => {
    expect(containsDirectIdentifier("at home", { name: "at", id: "5" })).toBe(false);
  });
});

describe("both functions apply it", () => {
  it("generate-letter sends tokens and restores afterwards", () => {
    expect(generateLetter).toMatch(/placeholderPatientHeader\(/);
    expect(generateLetter).toMatch(/restorePatientIdentifiers\(/);
  });

  it("regenerate-letter strips the existing draft before sending it back", () => {
    // Without this the minimisation is undone on the first refinement.
    expect(regenerateLetter).toMatch(/redactPatientIdentifiers\(letter\.letter_content/);
    expect(regenerateLetter).toMatch(/redactPatientIdentifiers\(letter\.transcript/);
    expect(regenerateLetter).toMatch(/restorePatientIdentifiers\(/);
  });

  it("checks the assembled prompt before the request is sent", () => {
    for (const [name, src] of [
      ["generate-letter", generateLetter],
      ["regenerate-letter", regenerateLetter],
    ] as const) {
      const guardAt = src.indexOf("containsDirectIdentifier(");
      const sendAt = src.indexOf("chatCompletionsUrl(");
      expect(guardAt, `${name}: no leak check`).toBeGreaterThan(-1);
      expect(sendAt, `${name}: no completion call`).toBeGreaterThan(-1);
      expect(guardAt, `${name}: the check must precede the request`).toBeLessThan(sendAt);
    }
  });

  it("no longer interpolates the raw identifiers into a prompt", () => {
    // The template literal that used to read `Patient Name: ${patient_name}`.
    const code = generateLetter.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/Patient Name: \$\{patient_name\}/);
    expect(code).not.toMatch(/NHS Number: \$\{patient_id\}/);
  });
});
