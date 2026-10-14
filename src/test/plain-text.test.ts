// @vitest-environment node
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { containsMarkdown, stripMarkdown } from "../../supabase/functions/_shared/plain-text.ts";

/**
 * A clinical letter is edited in a plain textarea, copied into record
 * systems, emailed and printed. There is nowhere in that chain where `**`
 * means anything, so it is removed rather than rendered.
 *
 * The risk in stripping is the opposite of the problem: clinical text is full
 * of characters that look like Markdown and are not. `# NOF` is a fractured
 * neck of femur. These tests are mostly about what must survive.
 */

const ROOT = join(__dirname, "../..");

describe("removing formatting the model was asked not to produce", () => {
  it("unwraps bold", () => {
    expect(stripMarkdown("**Active problems**")).toBe("Active problems");
    expect(stripMarkdown("Started on **amlodipine 5mg**.")).toBe("Started on amlodipine 5mg.");
  });

  it("unwraps italic and bold-italic", () => {
    expect(stripMarkdown("*pro re nata*")).toBe("pro re nata");
    expect(stripMarkdown("***urgent***")).toBe("urgent");
  });

  it("unwraps underscore emphasis", () => {
    expect(stripMarkdown("__Plan__")).toBe("Plan");
    expect(stripMarkdown("_reviewed_")).toBe("reviewed");
  });

  it("removes heading markers", () => {
    expect(stripMarkdown("## Examination")).toBe("Examination");
    expect(stripMarkdown("### Plan\nReview in six weeks.")).toBe("Plan\nReview in six weeks.");
  });

  it("turns asterisk bullets into hyphens", () => {
    expect(stripMarkdown("* Amlodipine 5mg\n* Atorvastatin 20mg")).toBe(
      "- Amlodipine 5mg\n- Atorvastatin 20mg",
    );
  });

  it("keeps the words of a link and shows the address", () => {
    expect(stripMarkdown("See [the guideline](https://nice.org.uk/x)")).toBe(
      "See the guideline (https://nice.org.uk/x)",
    );
  });
});

describe("what must survive, because it is clinical and not Markdown", () => {
  it("leaves a fractured neck of femur alone", () => {
    // "# NOF" is a fracture, not a level-one heading. Stripping the hash
    // would change the meaning of the sentence.
    expect(stripMarkdown("# NOF")).toBe("# NOF");
    expect(stripMarkdown("# wrist")).toBe("# wrist");
  });

  it("leaves a lone asterisk used as a footnote marker", () => {
    expect(stripMarkdown("Creatinine 112*")).toBe("Creatinine 112*");
    expect(stripMarkdown("* denotes an abnormal result")).toBe("- denotes an abnormal result");
  });

  it("leaves multiplication and units alone", () => {
    expect(stripMarkdown("2 * 500mg")).toBe("2 * 500mg");
    expect(stripMarkdown("5mg * 3 days")).toBe("5mg * 3 days");
  });

  it("leaves underscores inside words", () => {
    expect(stripMarkdown("U&E_results")).toBe("U&E_results");
    expect(stripMarkdown("patient_id")).toBe("patient_id");
  });

  it("leaves hyphen bullets as they are", () => {
    const list = "- Amlodipine 5mg\n- Atorvastatin 20mg";
    expect(stripMarkdown(list)).toBe(list);
  });

  it("leaves an ordinary clinical letter untouched", () => {
    const letter = [
      "Dear Dr Shah,",
      "",
      "Re: Jane O'Brien-Smith",
      "",
      "I reviewed Mrs O'Brien-Smith in clinic today. She reports a three-week",
      "history of exertional chest pain. BP 140/85, pulse 72 and regular.",
      "",
      "Plan: start amlodipine 5mg daily, review in six weeks.",
      "",
      "Yours sincerely,",
    ].join("\n");
    expect(stripMarkdown(letter)).toBe(letter);
    expect(containsMarkdown(letter)).toBe(false);
  });

  it("handles empty and absent text without throwing", () => {
    expect(stripMarkdown("")).toBe("");
    expect(() => stripMarkdown(undefined as unknown as string)).not.toThrow();
  });
});

describe("a realistic letter the model formatted anyway", () => {
  it("comes out as something a clinician can paste into a record system", () => {
    const generated = [
      "## Clinic Letter",
      "",
      "**Diagnosis:** Stable angina",
      "",
      "**Medications:**",
      "* Amlodipine 5mg once daily",
      "* Atorvastatin 20mg at night",
      "",
      "**Plan:** Review in *six weeks*.",
    ].join("\n");

    expect(stripMarkdown(generated)).toBe([
      "Clinic Letter",
      "",
      "Diagnosis: Stable angina",
      "",
      "Medications:",
      "- Amlodipine 5mg once daily",
      "- Atorvastatin 20mg at night",
      "",
      "Plan: Review in six weeks.",
    ].join("\n"));
  });

  it("is idempotent, so saving a cleaned letter changes nothing further", () => {
    const once = stripMarkdown("**Plan:** review *soon*");
    expect(stripMarkdown(once)).toBe(once);
  });
});

describe("it is applied where letters are produced", () => {
  const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

  it("generate-letter strips before storing", () => {
    // Prompt instructions already asked for no bold, in three places, and the
    // model produced it regardless. The strip is the control.
    expect(read("supabase/functions/generate-letter/index.ts")).toMatch(/stripMarkdown\(/);
  });

  it("regenerate-letter strips too", () => {
    // Otherwise a refinement reintroduces what generation removed.
    expect(read("supabase/functions/regenerate-letter/index.ts")).toMatch(/stripMarkdown\(/);
  });
});
