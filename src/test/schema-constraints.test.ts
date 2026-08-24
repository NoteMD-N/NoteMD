// @vitest-environment node
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Static guard against writing a value the database will reject.
 *
 * "Autosave doesn't work" and "discard doesn't save" were both caused by
 * recordings.status having a CHECK constraint that omitted 'draft'. The
 * application inserted 'draft', Postgres rejected every row, and no draft ever
 * appeared. The client code was correct; the schema disagreed with it.
 *
 * That mismatch is invisible in TypeScript — status is just a string — so this
 * test reads the CHECK constraint out of the migrations and asserts that every
 * status literal the app writes is actually permitted.
 */

const ROOT = join(__dirname, "../..");
const MIGRATIONS = join(ROOT, "supabase/migrations");
const SOURCES = [
  join(ROOT, "src/pages/Record.tsx"),
  join(ROOT, "supabase/functions/generate-letter/index.ts"),
  join(ROOT, "supabase/functions/regenerate-letter/index.ts"),
];

/** All migration SQL, oldest first, so later ALTERs win. */
function migrationSql(): string {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(join(MIGRATIONS, f), "utf8"))
    .join("\n");
}

/**
 * Effective allowed values for a table's status column: the LAST
 * `CHECK (status IN (...))` applied to that table across all migrations.
 */
function allowedStatuses(table: string): string[] {
  const sql = migrationSql();

  // The gap between the table reference and the CHECK must not cross into
  // another table's definition, or we pick up a different table's constraint.
  // Excluding the word TABLE from the gap keeps each match inside one statement.
  const re = new RegExp(
    `(?:CREATE TABLE (?:IF NOT EXISTS )?public\\.${table}\\b|ALTER TABLE public\\.${table}\\b)` +
      `((?:(?!\\bTABLE\\b)[\\s\\S])*?)` +
      `CHECK\\s*\\(\\s*status IN\\s*\\(([^)]*)\\)`,
    "gi",
  );

  let last: string | null = null;
  for (const m of sql.matchAll(re)) last = m[2];
  if (!last) throw new Error(`No status CHECK constraint found for ${table}`);
  return [...last.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/** Status literals written to a given table in application code. */
function statusesWrittenTo(table: string): Set<string> {
  const found = new Set<string>();

  for (const file of SOURCES) {
    let src: string;
    try { src = readFileSync(file, "utf8"); } catch { continue; }

    const fromCall = /\.from\(\s*["']([a-z_]+)["']\s*\)/g;
    const calls = [...src.matchAll(fromCall)];

    calls.forEach((m, i) => {
      if (m[1] !== table) return;
      // The query chain for this table ends where the next .from() begins;
      // otherwise a following query on a different table bleeds in and we
      // attribute its status values to the wrong table.
      const start = m.index!;
      const next = calls[i + 1]?.index ?? src.length;
      const chunk = src.slice(start, Math.min(next, start + 1200));
      for (const s of chunk.matchAll(/status:\s*["']([a-z_]+)["']/g)) {
        found.add(s[1]);
      }
    });
  }
  return found;
}

describe("recordings.status", () => {
  const allowed = allowedStatuses("recordings");

  it("permits 'draft' — required by autosave and discard-to-draft", () => {
    // The exact regression: without this, every draft insert is rejected by
    // Postgres and no in-progress session is ever recoverable.
    expect(allowed).toContain("draft");
  });

  it("still permits the original lifecycle values", () => {
    for (const s of ["uploaded", "processing", "transcribed", "letter_generated", "error"]) {
      expect(allowed).toContain(s);
    }
  });

  it("permits every status the application writes to it", () => {
    const written = statusesWrittenTo("recordings");
    expect(written.size).toBeGreaterThan(0);
    for (const s of written) {
      expect(allowed, `application writes recordings.status='${s}' but the CHECK constraint forbids it`).toContain(s);
    }
  });
});

describe("letters.status", () => {
  const allowed = allowedStatuses("letters");

  it("permits every status the application writes to it", () => {
    const written = statusesWrittenTo("letters");
    expect(written.size).toBeGreaterThan(0);
    for (const s of written) {
      expect(allowed, `application writes letters.status='${s}' but the CHECK constraint forbids it`).toContain(s);
    }
  });
});
