// @vitest-environment node
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ALLOWED_HEADERS, corsHeaders } from "../../supabase/functions/_shared/cors";

/**
 * Repo-level guards for the edge functions.
 *
 * The "Failed to send a request to the Edge Function" error is a CORS preflight
 * rejection wearing a disguise: if a header the browser sends is missing from
 * Access-Control-Allow-Headers, the request never leaves the browser and the
 * error looks like a missing function.
 *
 * That bug was fixed once in generate-letter and left everywhere else, so each
 * new function reintroduced it. These tests make the fix structural.
 */

const FUNCTIONS_DIR = join(__dirname, "../../supabase/functions");

function functionDirs(): string[] {
  if (!existsSync(FUNCTIONS_DIR)) return [];
  return readdirSync(FUNCTIONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("_"))
    .map((d) => d.name);
}

describe("shared CORS headers", () => {
  it("allows every header the Supabase browser client sends", () => {
    // Missing any of these breaks the preflight for browser-invoked functions.
    const required = [
      "authorization",
      "content-type",
      "apikey",
      "x-client-info",
      "x-supabase-client-platform",
      "x-supabase-client-platform-version",
      "x-supabase-client-runtime",
      "x-supabase-client-runtime-version",
    ];
    for (const h of required) {
      expect(ALLOWED_HEADERS as readonly string[]).toContain(h);
    }
  });

  it("emits a comma-separated header string", () => {
    const value = corsHeaders["Access-Control-Allow-Headers"];
    expect(value).toContain("x-supabase-client-platform");
    expect(value.split(",").map((s) => s.trim())).toEqual([...ALLOWED_HEADERS]);
  });
});

describe("every edge function uses the shared CORS headers", () => {
  const dirs = functionDirs();

  it("finds the edge functions", () => {
    expect(dirs.length).toBeGreaterThan(0);
  });

  it.each(dirs)("%s imports corsHeaders from _shared and defines none locally", (name) => {
    const src = readFileSync(join(FUNCTIONS_DIR, name, "index.ts"), "utf8");
    expect(src).toContain('from "../_shared/cors.ts"');
    // A local redefinition would shadow the shared list and silently drift.
    expect(src).not.toMatch(/const corsHeaders\s*=\s*\{/);
  });

  it.each(dirs)("%s has no import statement nested inside another import block", (name) => {
    // Guards the exact malformation a naive insertion produced:
    //   import {
    //   import { corsHeaders } from "...";
    const src = readFileSync(join(FUNCTIONS_DIR, name, "index.ts"), "utf8");
    const lines = src.split("\n");
    let inBlock = false;
    for (const line of lines) {
      if (/^import\s*\{\s*$/.test(line)) { inBlock = true; continue; }
      if (/^\}\s*from/.test(line)) { inBlock = false; continue; }
      if (inBlock && /^import\s/.test(line)) {
        throw new Error(`${name}: import nested inside an import block: ${line.trim()}`);
      }
    }
    expect(inBlock).toBe(false);
  });

  it.each(dirs)("%s responds to CORS preflight", (name) => {
    const src = readFileSync(join(FUNCTIONS_DIR, name, "index.ts"), "utf8");
    expect(src).toContain('req.method === "OPTIONS"');
  });
});

describe("deployment configuration", () => {
  it("keeps gateway JWT verification off for the Stripe webhook", () => {
    // Stripe never sends a Supabase token. With verification on, the gateway
    // refuses every payment event with UNAUTHORIZED_NO_AUTH_HEADER before the
    // function runs. This was once set only via --no-verify-jwt at deploy time,
    // and a plain `supabase functions deploy` silently turned it back on.
    const toml = readFileSync(join(__dirname, "../../supabase/config.toml"), "utf8");
    expect(toml).toMatch(/\[functions\.stripe-webhook\]\s*\n\s*verify_jwt\s*=\s*false/);
  });

  it("authenticates Stripe itself, since the gateway does not", () => {
    const src = readFileSync(
      join(__dirname, "../../supabase/functions/stripe-webhook/index.ts"),
      "utf8",
    );
    expect(src).toMatch(/stripe-signature/i);
    expect(src).toMatch(/constructEventAsync\(/);
  });

  it("does not name the transcription vendor in client-facing errors", () => {
    const src = readFileSync(
      join(__dirname, "../../supabase/functions/deepgram-token/index.ts"),
      "utf8",
    );
    const response = src.slice(src.lastIndexOf("new Response("));
    expect(response).not.toMatch(/error\.message/);
    expect(response.toLowerCase()).not.toContain("deepgram");
  });
});
