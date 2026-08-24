// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  resolveStreamingHost,
  streamingHttpUrl,
  streamingWsUrl,
  isEuResidentStreamingHost,
  STREAMING_EU_HOST,
  STREAMING_GLOBAL_HOST,
} from "../../supabase/functions/_shared/transcription-policy";

/**
 * Data residency for the streaming engine.
 *
 * The global host resolves to Sacramento, California; the EU host resolves to
 * eu-central-1 (Frankfurt). Patient audio must stay on EU infrastructure, so
 * EU is the default and a misconfiguration must fail safe toward EU rather
 * than silently sending audio to the US.
 */

describe("resolveStreamingHost — fails safe to EU", () => {
  it("defaults to the EU host when nothing is configured", () => {
    for (const v of [undefined, null, "", "   "]) {
      expect(resolveStreamingHost(v)).toBe(STREAMING_EU_HOST);
    }
  });

  it("accepts a full https URL", () => {
    expect(resolveStreamingHost("https://api.eu.deepgram.com")).toBe(STREAMING_EU_HOST);
  });

  it("accepts a bare host with no scheme", () => {
    expect(resolveStreamingHost("api.eu.deepgram.com")).toBe(STREAMING_EU_HOST);
  });

  it("strips a trailing path and slash", () => {
    expect(resolveStreamingHost("https://api.eu.deepgram.com/")).toBe(STREAMING_EU_HOST);
    expect(resolveStreamingHost("https://api.eu.deepgram.com/v1/listen")).toBe(STREAMING_EU_HOST);
  });

  it("still allows an explicit switch back to the global host", () => {
    // Needed for diagnostics, but it is never the default.
    expect(resolveStreamingHost("https://api.deepgram.com")).toBe(STREAMING_GLOBAL_HOST);
  });
});

describe("URL construction", () => {
  it("builds the EU websocket URL by default", () => {
    expect(streamingWsUrl(undefined)).toBe("wss://api.eu.deepgram.com/v1/listen");
  });

  it("builds the EU https URL by default", () => {
    expect(streamingHttpUrl(undefined)).toBe("https://api.eu.deepgram.com/v1/listen");
  });

  it("never emits a malformed URL from a messy value", () => {
    for (const v of ["api.eu.deepgram.com/", "https://api.eu.deepgram.com//", "  "]) {
      const ws = streamingWsUrl(v);
      expect(ws.startsWith("wss://")).toBe(true);
      expect(ws).not.toMatch(/\/\/v1|\/\/$/);
    }
  });
});

describe("isEuResidentStreamingHost — residency assertion", () => {
  it("reports EU for the default configuration", () => {
    expect(isEuResidentStreamingHost(undefined)).toBe(true);
    expect(isEuResidentStreamingHost("https://api.eu.deepgram.com")).toBe(true);
  });

  it("reports NON-EU for the global host, so it can be warned about", () => {
    expect(isEuResidentStreamingHost("https://api.deepgram.com")).toBe(false);
  });
});
