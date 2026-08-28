// @vitest-environment node
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Guards on the per-patient erasure migration.
 *
 * This is irreversible deletion of clinical records, so the safety properties
 * are asserted against the migration SQL itself rather than trusted to review.
 */

const MIGRATIONS = join(__dirname, "../../supabase/migrations");

function migrationSql(): string {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(join(MIGRATIONS, f), "utf8"))
    .join("\n");
}

function fnBody(name: string): string {
  const sql = migrationSql();
  const start = sql.indexOf(`FUNCTION public.${name}(`);
  expect(start, `function ${name} not found`).toBeGreaterThan(-1);
  // Function bodies are delimited by $$ ... $$
  const open = sql.indexOf("$$", start);
  const close = sql.indexOf("$$", open + 2);
  return sql.slice(open, close);
}

describe("per-patient functions exist", () => {
  it.each([
    "gdpr_find_patient_records",
    "gdpr_export_patient",
    "gdpr_erase_patient",
  ])("%s is defined", (name) => {
    expect(migrationSql()).toContain(`FUNCTION public.${name}(`);
  });
});

describe("erasure is scoped to the calling clinician", () => {
  const body = fnBody("gdpr_erase_patient");

  it("refuses to run unauthenticated", () => {
    expect(body).toMatch(/IF uid IS NULL THEN\s+RAISE EXCEPTION/);
  });

  it("scopes every delete to the caller's own rows", () => {
    // Each DELETE on a clinical table must be constrained by user_id = uid.
    const deletes = body.match(/DELETE FROM public\.(letters|recordings)[\s\S]*?;/g) ?? [];
    expect(deletes.length).toBeGreaterThanOrEqual(2);
    for (const d of deletes) {
      expect(d, `unscoped delete: ${d}`).toMatch(/user_id = uid/);
    }
  });

  it("scopes the audio object delete to the caller's own recordings", () => {
    expect(body).toMatch(/DELETE FROM storage\.objects[\s\S]*?r\.user_id = uid/);
  });

  it("sets an empty search_path on every security-definer function", () => {
    // Prevents search-path hijacking. Parse actual function headers rather
    // than counting the phrase, which also appears in comments.
    const sql = migrationSql();
    const headers = [...sql.matchAll(
      /CREATE (?:OR REPLACE )?FUNCTION\s+(public\.\w+)\s*\(([\s\S]*?)AS\s*\$\$/g,
    )];
    expect(headers.length).toBeGreaterThan(0);

    const offenders = headers
      .filter(([, , header]) => header.includes("SECURITY DEFINER") && !header.includes("search_path"))
      .map(([, name]) => name);

    expect(offenders, `SECURITY DEFINER without a locked search_path: ${offenders.join(", ")}`).toEqual([]);
  });
});

describe("erasure cannot act on a different set than was previewed", () => {
  const body = fnBody("gdpr_erase_patient");

  it("compares the caller's expected count against the actual count", () => {
    expect(body).toContain("p_expected_count");
    expect(body).toMatch(/p_expected_count IS NOT NULL AND p_expected_count <> actual_count/);
  });

  it("aborts rather than deleting when the counts disagree", () => {
    const guard = body.slice(body.indexOf("p_expected_count <> actual_count"));
    // The very next statement must raise, not delete.
    expect(guard.slice(0, 400)).toMatch(/RAISE EXCEPTION/);
  });

  it("does nothing when no records match", () => {
    expect(body).toMatch(/actual_count = 0[\s\S]*?RETURN/);
  });
});

describe("matching rules", () => {
  const body = fnBody("gdpr_find_patient_records");

  it("requires at least one search criterion", () => {
    expect(body).toMatch(/norm_id IS NULL AND norm_name IS NULL[\s\S]*?RAISE EXCEPTION/);
  });

  it("treats the patient id as authoritative when supplied", () => {
    // Name matching must only apply when no id was given, since names are
    // not unique and would otherwise widen the delete set.
    expect(body).toMatch(/norm_id IS NULL AND norm_name IS NOT NULL/);
  });

  it("normalises identifiers so spacing does not change the match", () => {
    expect(migrationSql()).toContain("gdpr_norm_patient_id");
    expect(fnBody("gdpr_norm_patient_id")).toMatch(/regexp_replace/);
  });
});

describe("audit trail records the action without the content", () => {
  it("logs erasure with counts only, never the patient identifier", () => {
    const body = fnBody("gdpr_erase_patient");
    const insert = body.slice(body.indexOf("INSERT INTO public.processing_audit_log"));
    expect(insert).toContain("patient_data_erased");
    expect(insert).toContain("recordings_deleted");
    // The identifier must not be copied into the audit record.
    expect(insert).not.toMatch(/p_patient_id|p_patient_name/);
  });

  it("logs export with counts only", () => {
    const body = fnBody("gdpr_export_patient");
    const insert = body.slice(body.indexOf("INSERT INTO public.processing_audit_log"));
    expect(insert).toContain("patient_data_exported");
    expect(insert).not.toMatch(/p_patient_id|p_patient_name/);
  });
});
