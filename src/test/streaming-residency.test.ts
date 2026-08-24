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

import { resolveResidencyVerdict } from "../../supabase/functions/_shared/transcription-policy";

/**
 * Verdict correlation.
 *
 * The first version of the verification script tested each endpoint in
 * isolation and reported a rejected-everywhere key as "GOOD — region-locked",
 * which is the opposite of the truth. These cases pin the correlation.
 */
describe("resolveResidencyVerdict", () => {
  const EU = { configuredReachable: true, euConfigured: true };

  it("EU accepted + global rejected = region-locked credential (best case)", () => {
    expect(resolveResidencyVerdict({
      ...EU, configuredKeyAccepted: true, globalKeyAccepted: false,
    })).toBe("eu_ok_region_locked");
  });

  it("EU accepted + global accepted = working, but not region-locked", () => {
    expect(resolveResidencyVerdict({
      ...EU, configuredKeyAccepted: true, globalKeyAccepted: true,
    })).toBe("eu_ok");
  });

  it("EU rejected + global accepted = account not EU-provisioned", () => {
    expect(resolveResidencyVerdict({
      ...EU, configuredKeyAccepted: false, globalKeyAccepted: true,
    })).toBe("not_provisioned");
  });

  it("rejected everywhere = INVALID KEY, never 'region-locked'", () => {
    // The exact misdiagnosis that shipped in the first script.
    const verdict = resolveResidencyVerdict({
      ...EU, configuredKeyAccepted: false, globalKeyAccepted: false,
    });
    expect(verdict).toBe("invalid_key");
    expect(verdict).not.toBe("eu_ok_region_locked");
  });

  it("unreachable endpoint is never reported as a residency pass", () => {
    const verdict = resolveResidencyVerdict({
      configuredReachable: false,
      euConfigured: true,
      configuredKeyAccepted: null,
      globalKeyAccepted: null,
    });
    expect(verdict).toBe("unreachable");
  });

  it("a non-EU configuration is flagged even when the key works", () => {
    expect(resolveResidencyVerdict({
      configuredReachable: true,
      euConfigured: false,
      configuredKeyAccepted: true,
      globalKeyAccepted: true,
    })).toBe("not_eu_configured");
  });

  it("never reports a pass verdict when the key was not accepted", () => {
    const passes = ["eu_ok", "eu_ok_region_locked"];
    for (const globalKeyAccepted of [true, false, null]) {
      const v = resolveResidencyVerdict({
        ...EU, configuredKeyAccepted: false, globalKeyAccepted,
      });
      expect(passes).not.toContain(v);
    }
  });
});
