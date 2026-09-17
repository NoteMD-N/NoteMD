// @vitest-environment node
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { redactError, redactVendorError } from "../../supabase/functions/_shared/redact.ts";

/**
 * Clinical content must not reach application or server logs.
 *
 * The obvious risk — deliberately logging a transcript — is easy to avoid and
 * nobody does it. The one that actually happens is `console.error("...", err)`,
 * which reads as harmless. A PostgrestError from a rejected insert carries a
 * `details` field, and on a constraint violation Postgres fills it with the
 * offending row: patient name, NHS number and transcript, written straight
 * into retained logs.
 *
 * So these cover both halves: that the redactor drops the dangerous fields,
 * and that every call site actually uses it.
 */

const ROOT = join(__dirname, "../..");
const FUNCTIONS = join(ROOT, "supabase/functions");

function edgeSources(): { path: string; body: string }[] {
  const out: { path: string; body: string }[] = [];
  for (const entry of readdirSync(FUNCTIONS, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const p = join(FUNCTIONS, entry.name, "index.ts");
      try {
        out.push({ path: `${entry.name}/index.ts`, body: readFileSync(p, "utf8") });
      } catch {
        /* no index.ts */
      }
    } else if (entry.name.endsWith(".ts")) {
      out.push({
        path: `_shared/${entry.name}`,
        body: readFileSync(join(FUNCTIONS, entry.name), "utf8"),
      });
    }
  }
  for (const f of readdirSync(join(FUNCTIONS, "_shared"))) {
    out.push({
      path: `_shared/${f}`,
      body: readFileSync(join(FUNCTIONS, "_shared", f), "utf8"),
    });
  }
  return out;
}

describe("redactError drops what Postgres puts in a failed insert", () => {
  it("never emits the failing row", () => {
    // This is the exact shape supabase-js surfaces for a CHECK violation.
    const postgrestError = {
      code: "23514",
      message: 'new row for relation "letters" violates check constraint',
      details:
        "Failing row contains (b1f2, 9c3a, 'Jane Smith', 'NHS4857773456', " +
        "'Patient presents with a three-week history of chest pain radiating " +
        "to the left arm, worse on exertion...', draft).",
      hint: null,
    };

    const out = redactError(postgrestError);

    expect(out).not.toContain("Jane Smith");
    expect(out).not.toContain("NHS4857773456");
    expect(out).not.toContain("chest pain");
    expect(out).not.toContain("Failing row");

    // Still useful for diagnosis.
    expect(out).toContain("code=23514");
    expect(out).toContain("check constraint");
    // The presence and size of the dropped field is recorded, not its content.
    expect(out).toMatch(/details=\[redacted \d+ chars\]/);
  });

  it("caps a message that carries content", () => {
    const err = new Error("Letter body: " + "x".repeat(5000));
    const out = redactError(err);
    expect(out.length).toBeLessThan(400);
    expect(out).toContain("truncated");
  });

  it("handles the shapes a catch block actually receives", () => {
    expect(redactError(null)).toBe("(no error object)");
    expect(redactError(undefined)).toBe("(no error object)");
    expect(redactError("plain string")).toContain("plain string");
    expect(redactError(new Error("boom"))).toContain('message="boom"');
    expect(redactError({ status: 502 })).toContain("status=502");
    expect(redactError(42)).toBe("(number)");
  });

  it("never returns a hint or a response body", () => {
    const out = redactError({
      message: "failed",
      hint: "Perhaps you meant patient_name = 'Jane Smith'",
      body: "transcript: chest pain radiating to the left arm",
      response: { data: { transcript: "clinical narrative" } },
    });
    expect(out).not.toContain("Jane Smith");
    expect(out).not.toContain("chest pain");
    expect(out).not.toContain("clinical narrative");
  });
});

describe("redactVendorError drops an echoed payload", () => {
  it("keeps diagnostics and discards the rest", () => {
    const out = redactVendorError(
      JSON.stringify({
        error: {
          code: "invalid_request",
          message: "Unsupported value",
          input: "Patient presents with chest pain radiating to the left arm",
        },
      }),
    );
    expect(out).toContain("code=invalid_request");
    expect(out).not.toContain("chest pain");
  });

  it("records only the size of a non-JSON body", () => {
    expect(redactVendorError("<html>Jane Smith NHS4857773456</html>")).toMatch(
      /non-JSON response, \d+ chars/,
    );
  });
});

/**
 * The expression parts of a log call: template-literal interpolations and
 * bare arguments, with literal text removed.
 *
 * Checking the raw argument string produces false positives — "[send-
 * transcript-email]" and "Falling back to client transcript" both contain the
 * word, and neither logs anything. What matters is whether a clinical value is
 * *evaluated* into the output.
 */
function loggedExpressions(args: string): string {
  const interpolations = [...args.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1]);
  const withoutStrings = args
    .replace(/`[^`]*`/g, " ")
    .replace(/"[^"]*"/g, " ")
    .replace(/'[^']*'/g, " ");
  return [withoutStrings, ...interpolations].join(" ");
}

describe("every edge function call site uses the redactors", () => {
  const sources = edgeSources();

  it("logs no bare error object", () => {
    // `console.error("...", err)` is the pattern that leaks. Comments are
    // stripped so the redactor's own documentation does not match.
    const offenders: string[] = [];
    for (const { path, body } of sources) {
      if (path.endsWith("redact.ts")) continue;
      const code = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      for (const m of code.matchAll(
        /console\.(?:error|warn|log|info|debug)\([^)]*?,\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/g,
      )) {
        const variable = m[1];
        if (/^(e|err|error|[a-z][A-Za-z]*Err(or)?)$/.test(variable)) {
          offenders.push(`${path}: logs bare \`${variable}\``);
        }
      }
    }
    expect(offenders, "these must be wrapped in redactError()").toEqual([]);
  });

  it("logs no clinical variable directly", () => {
    const forbidden = [
      "transcript", "letterContent", "letter_content", "patient_name",
      "patientName", "patient_id", "patientId", "systemPrompt", "userPrompt",
      "audioData", "bodyText", "bodyHtml",
    ];
    const offenders: string[] = [];
    for (const { path, body } of sources) {
      const code = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      for (const m of code.matchAll(/console\.[a-z]+\(([^;]*?)\);/g)) {
        const args = loggedExpressions(m[1]);
        for (const name of forbidden) {
          // `transcript.length` is a count, not content.
          const bare = new RegExp(`\\b${name}\\b(?!\\s*\\.\\s*length)`);
          if (bare.test(args)) offenders.push(`${path}: logs \`${name}\``);
        }
      }
    }
    expect([...new Set(offenders)]).toEqual([]);
  });

  it("logs no authentication material", () => {
    const offenders: string[] = [];
    for (const { path, body } of sources) {
      const code = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      for (const m of code.matchAll(/console\.[a-z]+\(([^;]*?)\);/g)) {
        if (/\b(authHeader|apiKey|API_KEY|accessToken|access_token|serviceRole|jwt)\b/i.test(loggedExpressions(m[1]))) {
          offenders.push(`${path}: ${m[1].slice(0, 60)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
