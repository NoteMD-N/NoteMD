// @vitest-environment node
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  PRODUCTION_PROJECT_REF,
  isPointedAtProductionData,
  supabaseProjectRef,
} from "@/lib/environment";

/**
 * Evidence that staging is actually separate from production.
 *
 * The separation is worth nothing if a build can quietly point at the wrong
 * database, so the checks here cover both halves: that the environment files
 * name different projects, and that a non-production build aimed at the
 * production project is detected rather than silently accepted.
 */

const ROOT = join(__dirname, "../..");

function envFile(name: string): Record<string, string> {
  const path = join(ROOT, name);
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    // Vite strips surrounding quotes when it loads these; the existing
    // production file uses them and the newer ones do not.
    out[trimmed.slice(0, eq)] = trimmed.slice(eq + 1).replace(/^["']|["']$/g, "");
  }
  return out;
}

const production = envFile(".env");
const staging = envFile(".env.staging");
const development = envFile(".env.development");

describe("environment separation", () => {
  it("points staging at a different Supabase project from production", () => {
    const prodRef = supabaseProjectRef(production.VITE_SUPABASE_URL ?? "");
    const stagingRef = supabaseProjectRef(staging.VITE_SUPABASE_URL ?? "");

    expect(prodRef, ".env has no usable Supabase URL").toBeTruthy();
    expect(stagingRef, ".env.staging has no usable Supabase URL").toBeTruthy();
    expect(stagingRef).not.toBe(prodRef);
  });

  it("points local development at staging, not production", () => {
    // The client's requirement: routine development and testing must stop
    // happening against the production clinical database.
    const devRef = supabaseProjectRef(development.VITE_SUPABASE_URL ?? "");
    expect(devRef).toBe(supabaseProjectRef(staging.VITE_SUPABASE_URL ?? ""));
    expect(devRef).not.toBe(PRODUCTION_PROJECT_REF);
  });

  it("uses a distinct publishable key per project", () => {
    expect(staging.VITE_SUPABASE_PUBLISHABLE_KEY).toBeTruthy();
    expect(staging.VITE_SUPABASE_PUBLISHABLE_KEY).not.toBe(
      production.VITE_SUPABASE_PUBLISHABLE_KEY,
    );
  });

  it("labels every environment explicitly", () => {
    expect(staging.VITE_APP_ENV).toBe("staging");
    expect(development.VITE_APP_ENV).toBe("local");
    expect(envFile(".env.production").VITE_APP_ENV).toBe("production");
  });

  it("keeps the recorded production ref in step with .env", () => {
    // environment.ts compares against this constant to detect a misdirected
    // build. If .env moves to a new project and the constant does not, the
    // guard silently stops working.
    expect(supabaseProjectRef(production.VITE_SUPABASE_URL ?? "")).toBe(
      PRODUCTION_PROJECT_REF,
    );
  });
});

describe("no service-role credentials in the repository", () => {
  it("keeps service-role keys and database passwords out of env files", () => {
    // A service-role JWT bypasses RLS entirely. It belongs in Supabase's
    // secret store, never in a file the frontend build can read.
    for (const name of [".env", ".env.staging", ".env.development", ".env.production"]) {
      const contents = Object.entries(envFile(name));
      for (const [key, value] of contents) {
        expect(key, `${name} exposes a service-role key`).not.toMatch(/SERVICE_ROLE/i);
        expect(key, `${name} exposes a database password`).not.toMatch(/DB_PASSWORD|DATABASE_PASSWORD/i);
        // A service-role JWT decodes to a payload naming the role.
        if (value.startsWith("eyJ")) {
          const payload = value.split(".")[1] ?? "";
          const decoded = Buffer.from(payload, "base64").toString("utf8");
          expect(decoded, `${name}:${key} is a service-role token`).not.toContain("service_role");
        }
      }
    }
  });
});

describe("misdirected build detection", () => {
  const PROD_URL = `https://${PRODUCTION_PROJECT_REF}.supabase.co`;
  const STAGING_URL = "https://toeurvqqucloareeujfa.supabase.co";

  it("flags a staging build aimed at production", () => {
    expect(isPointedAtProductionData("staging", PROD_URL)).toBe(true);
  });

  it("flags a local build aimed at production", () => {
    expect(isPointedAtProductionData("local", PROD_URL)).toBe(true);
  });

  it("does not flag production talking to production", () => {
    expect(isPointedAtProductionData("production", PROD_URL)).toBe(false);
  });

  it("does not flag staging talking to staging", () => {
    expect(isPointedAtProductionData("staging", STAGING_URL)).toBe(false);
  });

  it("parses a project ref out of a Supabase URL and rejects anything else", () => {
    expect(supabaseProjectRef(STAGING_URL)).toBe("toeurvqqucloareeujfa");
    expect(supabaseProjectRef("https://example.com")).toBeNull();
    expect(supabaseProjectRef("")).toBeNull();
  });
});
