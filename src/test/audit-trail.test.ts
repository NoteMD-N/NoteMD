// @vitest-environment node
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Evidence tests for the clinical audit trail.
 *
 * The controls these assert are the ones an assurance reviewer will ask us to
 * demonstrate: that the trail cannot be edited, that attribution cannot be
 * forged, and that clinical content cannot enter it. All three are enforced in
 * the database rather than by convention, so each is checked against the
 * migration rather than against a comment.
 *
 * The deny-list check matters most. The same list of forbidden `detail` keys
 * exists twice — once in SQL as a CHECK constraint, once in TypeScript so the
 * mistake is caught in development. Two copies drift. This asserts they cannot.
 */

const ROOT = join(__dirname, "../..");
const MIGRATIONS = join(ROOT, "supabase/migrations");

function migrationSql(): string {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(join(MIGRATIONS, f), "utf8"))
    .join("\n");
}

const sql = migrationSql();
const auditLib = readFileSync(join(ROOT, "src/lib/audit.ts"), "utf8");

/** Pulls a quoted string array out of a SQL `ARRAY[...]` literal. */
function sqlArrayLiteral(afterMarker: string): string[] {
  const start = sql.indexOf(afterMarker);
  expect(start, `marker not found: ${afterMarker}`).toBeGreaterThan(-1);
  const open = sql.indexOf("ARRAY[", start);
  const close = sql.indexOf("]", open);
  return [...sql.slice(open, close).matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/** Pulls a quoted string set out of the TypeScript `new Set([...])`. */
function tsSetLiteral(afterMarker: string): string[] {
  const start = auditLib.indexOf(afterMarker);
  expect(start, `marker not found: ${afterMarker}`).toBeGreaterThan(-1);
  const open = auditLib.indexOf("[", start);
  const close = auditLib.indexOf("]", open);
  return [...auditLib.slice(open, close).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

describe("audit trail — append-only", () => {
  it("blocks UPDATE and DELETE with a trigger, not only with RLS", () => {
    // RLS does not constrain the service role, which is the credential the
    // edge functions write with. A missing-policy approach would leave the
    // log editable by the same key that appends to it.
    expect(sql).toMatch(
      /CREATE TRIGGER processing_audit_log_no_update\s+BEFORE UPDATE OR DELETE ON public\.processing_audit_log/,
    );
    expect(sql).toMatch(/RAISE EXCEPTION 'processing_audit_log is append-only/);
  });

  it("revokes UPDATE, DELETE and TRUNCATE from client roles", () => {
    expect(sql).toMatch(
      /REVOKE UPDATE, DELETE, TRUNCATE ON public\.processing_audit_log FROM anon, authenticated/,
    );
  });

  it("grants no INSERT policy to the client", () => {
    // The only client write path is the RPC. A direct INSERT policy would let
    // a caller choose its own actor_user_id.
    const policies = [...sql.matchAll(/CREATE POLICY[^;]*processing_audit_log[^;]*;/g)]
      .map((m) => m[0])
      .join("\n");
    expect(policies).not.toMatch(/FOR INSERT/i);
    expect(policies).not.toMatch(/FOR ALL/i);
  });
});

describe("audit trail — attribution", () => {
  it("records actor and subject separately", () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS actor_user_id uuid/);
    expect(sql).toMatch(/actor_user_id SET NOT NULL/);
  });

  it("derives the actor from the session, never from an argument", () => {
    const fn = sql.slice(
      sql.indexOf("CREATE OR REPLACE FUNCTION public.log_audit_event"),
      sql.indexOf("REVOKE ALL ON FUNCTION public.log_audit_event"),
    );
    expect(fn).toMatch(/v_actor\s+uuid\s*:=\s*auth\.uid\(\)/);
    // There must be no parameter that sets the actor.
    expect(fn).not.toMatch(/p_actor/);
    expect(fn).toMatch(/INSERT INTO public\.processing_audit_log[\s\S]*?v_actor/);
  });

  it("refuses to attribute an event to an unrelated user", () => {
    const fn = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.log_audit_event"));
    // A subject that is neither the actor nor the actor's clinician is
    // rewritten to the actor and recorded as denied.
    expect(fn).toMatch(/v_subject <> v_actor AND \(v_clinician IS NULL OR v_subject <> v_clinician\)/);
    expect(fn).toMatch(/v_outcome\s*:=\s*'denied'/);
  });

  it("runs SECURITY DEFINER with an empty search_path", () => {
    const fn = sql.slice(
      sql.indexOf("CREATE OR REPLACE FUNCTION public.log_audit_event"),
      sql.indexOf("REVOKE ALL ON FUNCTION public.log_audit_event"),
    );
    expect(fn).toMatch(/SECURITY DEFINER/);
    expect(fn).toMatch(/SET search_path = ''/);
  });

  it("is executable by authenticated users only", () => {
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.log_audit_event[^;]*FROM PUBLIC/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.log_audit_event[^;]*TO authenticated/);
  });
});

describe("audit trail — no clinical content", () => {
  it("enforces the deny-list as a CHECK constraint", () => {
    expect(sql).toMatch(
      /ADD CONSTRAINT processing_audit_log_detail_clean\s+CHECK \(public\.audit_detail_is_clean\(detail\)\)/,
    );
  });

  it("caps the size of a detail payload", () => {
    expect(sql).toMatch(/length\(d::text\) > 4096/);
  });

  it("keeps the SQL and TypeScript deny-lists identical", () => {
    const fromSql = sqlArrayLiteral("banned CONSTANT text[]").sort();
    const fromTs = tsSetLiteral("const FORBIDDEN_DETAIL_KEYS").sort();
    expect(fromTs).toEqual(fromSql);
  });

  it("denies the keys that would carry clinical content or identifiers", () => {
    const banned = sqlArrayLiteral("banned CONSTANT text[]");
    for (const key of [
      "transcript", "letter_content", "audio", "prompt",
      "patient_name", "patient_id", "nhs_number", "dob",
    ]) {
      expect(banned, `deny-list is missing "${key}"`).toContain(key);
    }
  });

  it("rejects a detail payload that is not an object", () => {
    // jsonb_object_keys raises on a scalar; the handler must fail closed.
    const fn = sql.slice(sql.indexOf("FUNCTION public.audit_detail_is_clean"));
    expect(fn).toMatch(/WHEN others THEN RETURN false/);
  });
});

describe("audit trail — event vocabulary", () => {
  const actions = [...auditLib.matchAll(/^\s+[A-Z_]+:\s*"([a-z_]+\.[a-z_]+)",$/gm)].map((m) => m[1]);

  it("covers every event category the assurance scope requires", () => {
    const required: Record<string, string> = {
      "auth.login": "login",
      "auth.logout": "logout",
      "recording.created": "record creation",
      "recording.viewed": "record access",
      "recording.updated": "modification",
      "recording.deleted": "deletion",
      "transcription.completed": "transcription",
      "letter.generated": "AI letter generation",
      "letter.reviewed": "clinician approval",
      "letter.exported": "export/download",
      "letter.emailed": "email/send",
      "admin.secretary_added": "administrative action",
      "auth.mfa_enrolled": "security/account event",
    };
    for (const [action, label] of Object.entries(required)) {
      expect(actions, `no audit action covers ${label}`).toContain(action);
    }
  });

  it("namespaces every action", () => {
    expect(actions.length).toBeGreaterThan(20);
    for (const action of actions) {
      expect(action, `"${action}" is not namespaced`).toMatch(/^[a-z]+\.[a-z_]+$/);
    }
  });

  it("records failure and denial, not only success", () => {
    expect(sql).toMatch(/CHECK \(outcome IN \('success', 'failure', 'denied'\)\)/);
    expect(actions).toContain("auth.login_failed");
    expect(actions).toContain("letter.email_failed");
  });

  it("indexes denied attempts for investigation", () => {
    expect(sql).toMatch(/processing_audit_log_denied_idx[\s\S]*?WHERE outcome = 'denied'/);
  });
});
