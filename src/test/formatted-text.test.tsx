// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import FormattedText from "@/components/FormattedText";

/**
 * The client reported bold showing as literal asterisks.
 *
 * Editable clinical text has its Markdown stripped instead — a letter is
 * pasted into record systems, emailed and printed, and `**` is noise in all
 * three. This renderer is for the read-only summary, where the headings are
 * worth showing as headings.
 *
 * It builds React elements rather than setting HTML, so model output cannot
 * inject markup however it is shaped. That property is asserted below.
 */

describe("rendering the summariser's formatting", () => {
  it("shows bold as bold, not as asterisks", () => {
    render(<FormattedText text="Started on **amlodipine 5mg** daily." />);
    const strong = screen.getByText("amlodipine 5mg");
    expect(strong.tagName).toBe("STRONG");
    expect(document.body.textContent).not.toContain("**");
  });

  it("renders a whole-line heading without its markers", () => {
    render(<FormattedText text={"**Active problems**\nHypertension"} />);
    expect(screen.getByText("Active problems").tagName).toBe("P");
    expect(document.body.textContent).not.toContain("*");
  });

  it("renders bullets without showing the marker character", () => {
    render(<FormattedText text={"- Amlodipine 5mg\n- Atorvastatin 20mg"} />);
    expect(screen.getByText(/Amlodipine 5mg/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/^- /m);
  });

  it("leaves a lone asterisk alone", () => {
    // A footnote marker is not emphasis, and deleting it would change what
    // the summary says about an abnormal result.
    render(<FormattedText text="Creatinine 112* (abnormal)" />);
    expect(document.body.textContent).toContain("112*");
  });

  it("preserves line structure", () => {
    const { container } = render(<FormattedText text={"One\nTwo\nThree"} />);
    expect(container.textContent).toContain("One");
    expect(container.textContent).toContain("Three");
  });

  it("renders nothing for empty text", () => {
    const { container } = render(<FormattedText text="" />);
    expect(container.firstChild).toBeNull();
  });

  it("does not interpret HTML in the text", () => {
    // The text comes from a model reading uploaded documents. Rendering it as
    // markup would make a document the attack surface.
    const { container } = render(
      <FormattedText text={'<img src=x onerror="alert(1)"> and <b>bold</b>'} />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(container.textContent).toContain("<img src=x");
  });

  it("survives unbalanced markers without losing the words", () => {
    render(<FormattedText text="**unclosed bold and some text" />);
    expect(document.body.textContent).toContain("unclosed bold and some text");
  });
});
