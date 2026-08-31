// @vitest-environment node
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  streamingParams,
  batchParams,
  buildStreamingUrl,
  buildBatchUrl,
  hasPrivacyOptOut,
  REQUIRED_PRIVACY_PARAMS,
  STREAMING_EU_HOST,
} from "../../supabase/functions/_shared/transcription-policy";

/**
 * The vendor confirmed that mip_opt_out=true must be present on EVERY request
 * for audio to be excluded from retention and model training. A single call
 * without it re-introduces retention for that audio, so "usually set" is not a
 * meaningful state — these tests assert it holds unconditionally, and that no
 * call site can build a provider URL without going through the shared helpers.
 */

describe("privacy opt-out is present on every request shape", () => {
  it("is set on the streaming parameters", () => {
    expect(streamingParams().get("mip_opt_out")).toBe("true");
  });

  it("is set on the batch parameters", () => {
    expect(batchParams().get("mip_opt_out")).toBe("true");
  });

  it("cannot be overridden by a caller", () => {
    // Applied last in the spread, so a caller passing mip_opt_out=false loses.
    expect(streamingParams({ mip_opt_out: "false" }).get("mip_opt_out")).toBe("true");
    expect(batchParams({ mip_opt_out: "false" }).get("mip_opt_out")).toBe("true");
  });

  it("survives callers adding their own parameters", () => {
    const p = batchParams({ diarize: "true", foo: "bar" });
    expect(p.get("mip_opt_out")).toBe("true");
    expect(p.get("diarize")).toBe("true");
  });

  it("covers every parameter declared as required", () => {
    for (const [k, v] of Object.entries(REQUIRED_PRIVACY_PARAMS)) {
      expect(streamingParams().get(k)).toBe(v);
      expect(batchParams().get(k)).toBe(v);
    }
  });
});

describe("EU endpoint and opt-out together", () => {
  it("the streaming URL is EU-resident AND carries the opt-out", () => {
    const url = buildStreamingUrl(undefined);
    expect(url.startsWith(`wss://${STREAMING_EU_HOST}/`)).toBe(true);
    expect(hasPrivacyOptOut(url)).toBe(true);
  });

  it("the batch URL is EU-resident AND carries the opt-out", () => {
    const url = buildBatchUrl(undefined);
    expect(url.startsWith(`https://${STREAMING_EU_HOST}/`)).toBe(true);
    expect(hasPrivacyOptOut(url)).toBe(true);
  });

  it("keeps the opt-out even if the region is deliberately overridden", () => {
    // Region and retention are independent controls; changing one must not
    // silently drop the other.
    const url = buildBatchUrl("https://api.deepgram.com");
    expect(hasPrivacyOptOut(url)).toBe(true);
  });

  it("hasPrivacyOptOut rejects a URL missing the parameter", () => {
    expect(hasPrivacyOptOut("wss://api.eu.deepgram.com/v1/listen?model=nova-2-medical")).toBe(false);
    expect(hasPrivacyOptOut("wss://api.eu.deepgram.com/v1/listen")).toBe(false);
    expect(hasPrivacyOptOut("wss://api.eu.deepgram.com/v1/listen?mip_opt_out=false")).toBe(false);
  });
});

describe("no call site builds a provider URL by hand", () => {
  const ROOT = join(__dirname, "../..");

  const sources: string[] = [];
  const fnDir = join(ROOT, "supabase/functions");
  if (existsSync(fnDir)) {
    for (const d of readdirSync(fnDir, { withFileTypes: true })) {
      if (d.isDirectory() && !d.name.startsWith("_")) {
        sources.push(join(fnDir, d.name, "index.ts"));
      }
    }
  }
  sources.push(join(ROOT, "src/pages/Record.tsx"));

  it("finds the sources to check", () => {
    expect(sources.length).toBeGreaterThan(1);
  });

  it.each(sources.map((s) => [s.replace(ROOT + "/", ""), s]))(
    "%s does not hand-assemble a listen URL",
    (_label, file) => {
      const src = readFileSync(file, "utf8");
      // A literal /v1/listen with a query string means the call site built its
      // own parameters and could omit the opt-out.
      const handBuilt = src.match(/["'`][^"'`]*\/v1\/listen\?[^"'`]*["'`]/g) ?? [];
      expect(handBuilt, `hand-built provider URL in ${_label}: ${handBuilt.join(", ")}`).toEqual([]);
    },
  );

  it("the frontend does not construct provider query parameters", () => {
    const src = readFileSync(join(ROOT, "src/pages/Record.tsx"), "utf8");
    expect(src).not.toContain("nova-2-medical");
    expect(src).not.toMatch(/new URLSearchParams\(\{[\s\S]{0,200}model:/);
  });
});

import { redactVendorError } from "../../supabase/functions/_shared/redact";

/**
 * Vendor error bodies are logged for diagnostics. A vendor that echoed the
 * submitted content in an error would otherwise place clinical text into
 * retained logs.
 */
describe("vendor error redaction", () => {
  it("keeps diagnostic fields", () => {
    const out = redactVendorError(JSON.stringify({
      error: { code: "invalid_request", type: "invalid_request_error", param: "file" },
    }));
    expect(out).toContain("code=invalid_request");
    expect(out).toContain("param=file");
  });

  it("never echoes a submitted transcript back into the log", () => {
    const clinical = "Patient reports right-sided headache with visual aura and nausea";
    const out = redactVendorError(JSON.stringify({
      error: { code: "content_policy", input: clinical, transcript: clinical },
    }));
    expect(out).not.toContain("headache");
    expect(out).not.toContain(clinical);
    expect(out).toContain("code=content_policy");
  });

  it("truncates a long vendor message rather than trusting it", () => {
    const long = "x".repeat(1000);
    const out = redactVendorError(JSON.stringify({ error: { message: long } }));
    expect(out).toContain("[truncated]");
    expect(out.length).toBeLessThan(300);
  });

  it("reduces a non-JSON body to its size only", () => {
    const out = redactVendorError("<html><body>Patient John Smith, NHS 943 476 5919</body></html>");
    expect(out).not.toContain("John Smith");
    expect(out).not.toContain("943");
    expect(out).toMatch(/non-JSON response, \d+ chars/);
  });

  it("handles empty and missing bodies", () => {
    expect(redactVendorError("")).toBe("(empty response)");
    expect(redactVendorError(null)).toBe("(empty response)");
    expect(redactVendorError(undefined)).toBe("(empty response)");
  });
});
