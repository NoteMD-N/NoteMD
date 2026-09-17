// @vitest-environment node
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The clinical safety boundary:
 *
 *   AI generates a draft -> clinician reviews and edits -> clinician approves
 *   -> export or send.
 *
 * Generation is not approval. Two routes used to cross that line: send-letter-
 * email accepted any letter regardless of status, and generate-letter invoked
 * it directly for clinicians with auto-send enabled, so an AI draft nobody had
 * read could reach a recipient.
 *
 * These assert the boundary in the shipped code rather than in a comment,
 * because it is the kind of thing a later convenience change reintroduces
 * without anyone noticing.
 */

const ROOT = join(__dirname, "../..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/**
 * Source with comments removed.
 *
 * These checks are about what the code does, and the code explaining why it
 * no longer calls send-letter-email would otherwise read as it calling it.
 */
const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const sendLetterEmail = read("supabase/functions/send-letter-email/index.ts");
const generateLetter = read("supabase/functions/generate-letter/index.ts");
const letterView = read("src/pages/LetterView.tsx");

describe("send-letter-email refuses unreviewed letters", () => {
  it("defines the approved states without 'draft'", () => {
    const match = sendLetterEmail.match(/const APPROVED_FOR_SEND = \[([^\]]*)\]/);
    expect(match, "APPROVED_FOR_SEND is missing").toBeTruthy();
    const states = [...match![1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);

    expect(states, "'draft' must never be sendable").not.toContain("draft");
    expect(states, "a reviewed letter must be sendable").toContain("reviewed");
    // Re-sending something already sent stays possible.
    expect(states).toContain("exported");
  });

  it("checks the status before doing any sending work", () => {
    const gateAt = sendLetterEmail.indexOf("APPROVED_FOR_SEND.includes");
    const sendAt = sendLetterEmail.indexOf("api.resend.com");
    expect(gateAt).toBeGreaterThan(-1);
    expect(sendAt).toBeGreaterThan(-1);
    expect(gateAt, "the gate must precede the send call").toBeLessThan(sendAt);
  });

  it("returns a distinguishable refusal rather than a generic error", () => {
    // The UI has to tell "you must review this first" apart from "delivery
    // failed", because only one of them is the clinician's to act on.
    expect(sendLetterEmail).toMatch(/needs_review: true/);
    expect(sendLetterEmail).toMatch(/status: 409/);
  });

  it("records the refusal as a denied audit event", () => {
    const gate = sendLetterEmail.slice(
      sendLetterEmail.indexOf("APPROVED_FOR_SEND.includes"),
      sendLetterEmail.indexOf("api.resend.com"),
    );
    expect(gate).toMatch(/outcome: "denied"/);
    expect(gate).toMatch(/reason: "not_reviewed"/);
  });
});

describe("generate-letter does not send", () => {
  it("creates letters in draft", () => {
    expect(generateLetter).toMatch(/status: "draft"/);
  });

  it("never invokes send-letter-email", () => {
    // The whole failure mode was generation reaching a recipient directly.
    expect(codeOnly(generateLetter)).not.toMatch(/send-letter-email/);
  });

  it("does not read the auto-send settings at generation time", () => {
    expect(codeOnly(generateLetter)).not.toMatch(/auto_send_enabled/);
  });
});

describe("auto-send happens on review", () => {
  it("fires from the save handler, not from generation", () => {
    const save = letterView.slice(
      letterView.indexOf("const handleSave"),
      letterView.indexOf("const handleCopy"),
    );
    expect(save).toMatch(/status: "reviewed"/);
    expect(save, "auto-send must be triggered by the clinician's save").toMatch(
      /if \(autoSend\) void handleSendEmail\(\)/,
    );
  });

  it("only arms auto-send when recipients are actually configured", () => {
    expect(letterView).toMatch(
      /auto_send_enabled\)[\s\S]{0,80}auto_send_recipients\?\.length \?\? 0\) > 0/,
    );
  });

  it("surfaces the review requirement separately from a send failure", () => {
    expect(letterView).toMatch(/data\?\.needs_review/);
    expect(letterView).toMatch(/Review the letter and save it before sending/);
  });
});

describe("letter states", () => {
  it("permits exactly the states the workflow uses", () => {
    const migrations = read(
      "supabase/migrations/20260310134315_bca7d0e2-a40f-4bc6-ac55-0d851bc94cf9.sql",
    );
    const match = migrations.match(/status TEXT NOT NULL DEFAULT 'draft' CHECK \(status IN \(([^)]*)\)\)/);
    expect(match, "letters.status CHECK constraint not found").toBeTruthy();
    const allowed = [...match![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(allowed).toEqual(["draft", "reviewed", "exported"]);
  });
});
