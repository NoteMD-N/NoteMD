// @vitest-environment node
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PATIENT_ID_TOKEN,
  PATIENT_NAME_TOKEN,
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
  it("carries tokens instead of the patient's name and identifier", () => {
    const header = placeholderPatientHeader(PATIENT);
    expect(header).toContain(PATIENT_NAME_TOKEN);
    expect(header).toContain(PATIENT_ID_TOKEN);
    expect(header).not.toContain("Jane");
    expect(header).not.toContain("485 777 3456");
  });

  it("omits a token for an identifier we do not hold", () => {
    // Asking the model for a field we cannot fill afterwards would leave a
    // visible placeholder in the finished letter.
    const header = placeholderPatientHeader({ name: "Jane Smith", id: null });
    expect(header).toContain(PATIENT_NAME_TOKEN);
    expect(header).not.toContain(PATIENT_ID_TOKEN);
  });

  it("strips identifiers already present in an existing draft", () => {
    // Regeneration sends the current letter back, and that letter has the
    // real values substituted into it.
    const draft = `Dear Colleague,\n\nRe: ${PATIENT.name} (${PATIENT.id})\n\nSeen today.`;
    const out = redactPatientIdentifiers(draft, PATIENT);
    expect(out).not.toContain("Jane O'Brien-Smith");
    expect(out).not.toContain("485 777 3456");
    expect(out).toContain(PATIENT_NAME_TOKEN);
    expect(out).toContain(PATIENT_ID_TOKEN);
    expect(out).toContain("Seen today.");
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

  it("replaces every occurrence, not just the first", () => {
    const original = `${PATIENT.name} attended. ${PATIENT.name} was examined. ${PATIENT.name} left.`;
    const redacted = redactPatientIdentifiers(original, PATIENT);
    expect(redacted).not.toContain("Jane");
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
  it("detects an identifier that reached the prompt", () => {
    expect(containsDirectIdentifier(`Patient: ${PATIENT.name}`, PATIENT)).toBe(true);
    expect(containsDirectIdentifier(`NHS ${PATIENT.id}`, PATIENT)).toBe(true);
  });

  it("passes a prompt carrying only tokens", () => {
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
      const sendAt = src.indexOf('openAiUrl("chat/completions")');
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
