// @vitest-environment node
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CONTEXT_SUMMARY_PROMPT, MAX_CONTEXT_CHARS } from "../../supabase/functions/_shared/context-summary.ts";

/**
 * Background documents are summarised for the clinician to read, and the
 * summary is deliberately NOT an input to letter generation.
 *
 * That separation is the entire safety argument for the feature. A summary
 * saying "known hypertensive, on amlodipine 10mg" reads as established
 * history; feeding it to the letter would assert an error as fact in
 * correspondence, and nobody opens the source PDF to check. Kept as
 * reference, the same error meets a clinician's own judgement.
 *
 * It is asserted here because a convention whose reason has been forgotten
 * gets wired together within the year — by someone reasonably thinking the
 * letter would be better with more context in it.
 */

const ROOT = join(__dirname, "../..");
const fnDir = join(ROOT, "supabase/functions");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("context never reaches letter generation", () => {
  const letterFunctions = ["generate-letter", "regenerate-letter"];

  it("the letter functions do not import anything from the context modules", () => {
    for (const fn of letterFunctions) {
      const src = read(`supabase/functions/${fn}/index.ts`);
      expect(src, `${fn} imports the context summary prompt`).not.toMatch(/context-summary/);
      expect(src, `${fn} reads the context tables`).not.toMatch(/consultation_contexts|context_documents/);
    }
  });

  it("the letter functions accept no context field from the caller", () => {
    // The tables are covered above. This covers the other way in: a client
    // passing a summary straight into the request body, which would bypass
    // every database-level separation.
    for (const fn of letterFunctions) {
      const src = read(`supabase/functions/${fn}/index.ts`);
      expect(src, `${fn} accepts a context field`).not.toMatch(
        /context_summary|contextSummary|context_id|consultation_context/,
      );
    }
  });

  it("the summariser does not import the letter prompts", () => {
    // The other direction matters too: a shared prompt module would be a
    // path for one to start quoting the other.
    const src = read("supabase/functions/summarise-context/index.ts");
    expect(src).not.toMatch(/letter-prompt|generate-letter/);
  });

  it("the context prompt states that it is not used for letters", () => {
    // So the reason survives in the place someone editing it will look.
    expect(CONTEXT_SUMMARY_PROMPT).toMatch(/not used to write any letter/i);
    expect(CONTEXT_SUMMARY_PROMPT).toMatch(/reference material/i);
  });

  it("no function outside the summariser reads the context tables", () => {
    // Catches a future function wiring context in from somewhere new.
    const allowed = new Set(["summarise-context"]);
    for (const entry of readdirSync(fnDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || allowed.has(entry.name)) continue;
      let src: string;
      try { src = readFileSync(join(fnDir, entry.name, "index.ts"), "utf8"); }
      catch { continue; }
      expect(src, `${entry.name} reads the context tables`).not.toMatch(
        /consultation_contexts|context_documents/,
      );
    }
  });
});

describe("what the summariser is told", () => {
  it("forbids inventing anything", () => {
    // The failure is not a plausible-looking error but a confident one: a
    // drug that was stopped reported as current reads exactly like a drug
    // that is current.
    expect(CONTEXT_SUMMARY_PROMPT).toMatch(/Report only what the documents state/i);
    expect(CONTEXT_SUMMARY_PROMPT).toMatch(/[Nn]ever infer/);
  });

  it("requires uncertainty to be shown rather than resolved", () => {
    // Scanned pages are read from images and will contain misreads. A dose
    // that could be 5mg or 50mg must stay uncertain: resolving it silently
    // is how the wrong one ends up relied upon.
    expect(CONTEXT_SUMMARY_PROMPT).toMatch(/unclear|unreadable/i);
    expect(CONTEXT_SUMMARY_PROMPT).toMatch(/5mg or 50mg/);
  });

  it("requires current and historical to be distinguished", () => {
    expect(CONTEXT_SUMMARY_PROMPT).toMatch(/stopped must not be listed as current/i);
  });

  it("forbids writing a plan or a recommendation", () => {
    // It is background for a clinician about to see the patient, not an
    // assessment — and anything phrased as one invites being acted on.
    expect(CONTEXT_SUMMARY_PROMPT).toMatch(/not a clinical assessment/i);
    expect(CONTEXT_SUMMARY_PROMPT).toMatch(/[Dd]o not write a plan/);
  });

  it("bounds how much text one request may carry", () => {
    expect(MAX_CONTEXT_CHARS).toBeGreaterThan(10_000);
    expect(MAX_CONTEXT_CHARS).toBeLessThanOrEqual(200_000);
  });
});

describe("the documents are governed like the recording they belong to", () => {
  const migration = read("supabase/migrations/20261009120000_consultation_context.sql");

  it("keeps the bucket private and owner-scoped", () => {
    expect(migration).toMatch(/'context-documents', 'context-documents', false/);
    expect(migration).toMatch(/auth\.uid\(\)::text = \(storage\.foldername\(name\)\)\[1\]/);
  });

  it("enables row-level security on both tables", () => {
    expect(migration).toMatch(/ALTER TABLE public\.consultation_contexts ENABLE ROW LEVEL SECURITY/);
    expect(migration).toMatch(/ALTER TABLE public\.context_documents ENABLE ROW LEVEL SECURITY/);
  });

  it("purges documents on the audio retention period, not the transcript one", () => {
    // They are source material of the same kind as the recording, and more
    // directly identifying. Holding them for the ten years a transcript is
    // kept would make a convenience feature a second clinical archive.
    expect(migration).toMatch(/gdpr_purge_expired_context_documents/);
    expect(migration).toMatch(/p\.audio_retention_days/);
  });

  it("purges the extracted text along with the file", () => {
    // Otherwise the purge is cosmetic: the point is that the previous clinic
    // letter is gone, not that the PDF is.
    expect(migration).toMatch(/extracted_text = NULL/);
  });

  it("erases documents and storage objects on a right-to-erasure request", () => {
    expect(migration).toMatch(/gdpr_erase_context_documents/);
    expect(migration).toMatch(/DELETE FROM storage\.objects[\s\S]{0,120}context-documents/);
  });

  it("removes context when its recording is deleted", () => {
    expect(migration).toMatch(/recording_id uuid\s+REFERENCES public\.recordings\(id\) ON DELETE CASCADE/);
  });
});

describe("the summariser handles its own data carefully", () => {
  const src = read("supabase/functions/summarise-context/index.ts");

  it("reads through the caller's client so row-level security applies", () => {
    // The service role would see every clinician's documents.
    expect(src).not.toMatch(/SERVICE_ROLE/);
    expect(src).toMatch(/row-level security decides/i);
  });

  it("requires an authenticated caller before reaching a provider", () => {
    const authAt = src.indexOf("supabase.auth.getUser");
    // The call site, not the import at the top of the file.
    const providerAt = src.indexOf("resolveAiConfig((name)");
    expect(authAt).toBeGreaterThan(-1);
    expect(authAt).toBeLessThan(providerAt);
  });

  it("audits that documents were read, never what was in them", () => {
    const callAt = src.indexOf("await logAudit(");
    expect(callAt).toBeGreaterThan(-1);
    const auditBlock = src.slice(callAt, callAt + 500);
    expect(auditBlock).toMatch(/documents: documents\.length/);
    expect(auditBlock).not.toMatch(/summary,|extracted_text/);
  });

  it("is rate limited", () => {
    expect(src).toMatch(/checkRateLimit\(supabase, "summarise-context"\)/);
    expect(read("supabase/functions/_shared/rate-limit.ts")).toMatch(/"summarise-context"/);
  });
});
