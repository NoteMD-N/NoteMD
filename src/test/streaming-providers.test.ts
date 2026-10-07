// @vitest-environment node
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_ASSEMBLYAI_MODEL,
  DEFAULT_DEEPGRAM_MODEL,
  VENDOR_HOSTS,
  assemblyAiWsUrl,
  audioFormatFor,
  deepgramWsUrl,
  hasRequiredPrivacyControls,
  isEuHost,
  modelFor,
  resolveHost,
  resolveVendors,
} from "../../supabase/functions/_shared/streaming-providers.ts";

/**
 * The browser streams consultation audio straight to the vendor, so these
 * decisions cannot be left to the client: which vendor, which region, and
 * whether the audio may be retained or trained on.
 *
 * The two vendors are opted out of training by different mechanisms, and the
 * difference is the point. Deepgram is excluded by a parameter we add to every
 * request. AssemblyAI is excluded by processing in their European data zone.
 * One is enforced per call, the other by the host — so "the audio is not
 * trained on" is only true if both are checked in their own way.
 */

const ROOT = join(__dirname, "../..");
const env = (vars: Record<string, string>) => (name: string) => vars[name];

describe("choosing a vendor", () => {
  const BOTH = { DEEPGRAM_API_KEY: "dg-key", ASSEMBLYAI_API_KEY: "aai-key" };

  it("defaults to Deepgram when nothing is configured", () => {
    expect(resolveVendors(env(BOTH)).primary).toBe("deepgram");
  });

  it("uses the configured primary", () => {
    expect(resolveVendors(env({ ...BOTH, STREAMING_PRIMARY: "assemblyai" })).primary).toBe("assemblyai");
  });

  it("records a fallback only when one is configured", () => {
    const withFallback = resolveVendors(
      env({ ...BOTH, STREAMING_PRIMARY: "assemblyai", STREAMING_FALLBACK: "deepgram" }),
    );
    expect(withFallback).toEqual({ primary: "assemblyai", fallback: "deepgram" });

    expect(resolveVendors(env({ ...BOTH, STREAMING_PRIMARY: "assemblyai" })).fallback).toBeNull();
  });

  it("refuses a fallback that is the primary", () => {
    // A fallback to the vendor that just failed is not a fallback.
    const resolved = resolveVendors(
      env({ ...BOTH, STREAMING_PRIMARY: "assemblyai", STREAMING_FALLBACK: "assemblyai" }),
    );
    expect(resolved.fallback).toBeNull();
  });

  it("ignores a fallback with no credential", () => {
    const resolved = resolveVendors(
      env({ ASSEMBLYAI_API_KEY: "aai", STREAMING_PRIMARY: "assemblyai", STREAMING_FALLBACK: "deepgram" }),
    );
    expect(resolved).toEqual({ primary: "assemblyai", fallback: null });
  });

  it("serves from the other vendor when the primary has no key", () => {
    // A consultation must not fail because a key was never set. The same
    // asymmetry as the AI provider: a fallback still transcribes, a
    // misconfigured primary transcribes nothing.
    const resolved = resolveVendors(
      env({ DEEPGRAM_API_KEY: "dg", STREAMING_PRIMARY: "assemblyai" }),
    );
    expect(resolved.primary).toBe("deepgram");
  });

  it("reports the configured primary when neither is usable", () => {
    // Nothing can serve. The caller turns this into a clear error rather than
    // handing the browser a session that cannot connect.
    const resolved = resolveVendors(env({ STREAMING_PRIMARY: "assemblyai" }));
    expect(resolved).toEqual({ primary: "assemblyai", fallback: null });
  });

  it("treats an unrecognised vendor name as Deepgram rather than failing", () => {
    expect(resolveVendors(env({ ...BOTH, STREAMING_PRIMARY: "whisper" })).primary).toBe("deepgram");
  });
});

describe("keeping audio inside the EEA", () => {
  it("knows each vendor's EU host", () => {
    expect(VENDOR_HOSTS.deepgram.eu).toBe("api.eu.deepgram.com");
    expect(VENDOR_HOSTS.assemblyai.eu).toBe("streaming.eu.assemblyai.com");
  });

  it("rejects each vendor's default host", () => {
    // AssemblyAI's default edge-routes to the nearest region, which includes
    // the United States. It is not a neutral default for clinical audio.
    expect(isEuHost("assemblyai", "streaming.assemblyai.com")).toBe(false);
    expect(isEuHost("deepgram", "api.deepgram.com")).toBe(false);
  });

  it("does not accept one vendor's EU host for the other", () => {
    expect(isEuHost("deepgram", "streaming.eu.assemblyai.com")).toBe(false);
    expect(isEuHost("assemblyai", "api.eu.deepgram.com")).toBe(false);
  });

  it("defaults to the EU host when nothing is configured", () => {
    expect(resolveHost("assemblyai", null)).toBe("streaming.eu.assemblyai.com");
    expect(resolveHost("deepgram", undefined)).toBe("api.eu.deepgram.com");
    expect(resolveHost("deepgram", "")).toBe("api.eu.deepgram.com");
  });

  it("normalises a configured host written as a URL", () => {
    expect(resolveHost("assemblyai", "https://streaming.eu.assemblyai.com/")).toBe(
      "streaming.eu.assemblyai.com",
    );
  });
});

describe("the privacy controls on an issued URL", () => {
  it("accepts a Deepgram URL carrying the training opt-out", () => {
    const url = deepgramWsUrl("api.eu.deepgram.com", env({}));
    expect(url).toContain("mip_opt_out=true");
    expect(hasRequiredPrivacyControls("deepgram", url)).toBe(true);
  });

  it("rejects a Deepgram URL that has lost the opt-out", () => {
    // Enforced per request: one call without it re-introduces retention for
    // that audio, so the absence must fail rather than warn.
    const url = "wss://api.eu.deepgram.com/v1/listen?model=nova-3-medical";
    expect(hasRequiredPrivacyControls("deepgram", url)).toBe(false);
  });

  it("refuses to let a caller override the opt-out", () => {
    const url = deepgramWsUrl("api.eu.deepgram.com", env({ DEEPGRAM_LANGUAGE: "en-GB" }));
    const params = new URL(url).searchParams;
    expect(params.getAll("mip_opt_out")).toEqual(["true"]);
  });

  it("rejects any non-EU host for either vendor", () => {
    expect(hasRequiredPrivacyControls("deepgram", "wss://api.deepgram.com/v1/listen?mip_opt_out=true")).toBe(false);
    expect(hasRequiredPrivacyControls("assemblyai", "wss://streaming.assemblyai.com/v3/ws?token=t")).toBe(false);
  });

  it("accepts an AssemblyAI URL on the EU data zone", () => {
    // Their exclusion from training is a property of the European data zone,
    // so the host check is the control.
    const url = assemblyAiWsUrl("streaming.eu.assemblyai.com", "tok", env({}));
    expect(hasRequiredPrivacyControls("assemblyai", url)).toBe(true);
  });

  it("rejects a malformed URL rather than assuming it is safe", () => {
    expect(hasRequiredPrivacyControls("deepgram", "not a url")).toBe(false);
  });
});

describe("the recognition options sent to each vendor", () => {
  it("pins the model rather than letting the vendor choose", () => {
    // AssemblyAI selects its current flagship when speech_model is omitted, so
    // a vendor release could change clinical transcription with no deployment
    // on our side and nothing to notice it by.
    const url = new URL(assemblyAiWsUrl("streaming.eu.assemblyai.com", "tok", env({})));
    expect(url.searchParams.get("speech_model")).toBe(DEFAULT_ASSEMBLYAI_MODEL);

    const dg = new URL(deepgramWsUrl("api.eu.deepgram.com", env({})));
    expect(dg.searchParams.get("model")).toBe(DEFAULT_DEEPGRAM_MODEL);
  });

  it("lets each model be changed by configuration alone", () => {
    const url = new URL(
      assemblyAiWsUrl("streaming.eu.assemblyai.com", "tok", env({ ASSEMBLYAI_SPEECH_MODEL: "universal-3-6-pro" })),
    );
    expect(url.searchParams.get("speech_model")).toBe("universal-3-6-pro");
    expect(modelFor("assemblyai", env({ ASSEMBLYAI_SPEECH_MODEL: "universal-3-6-pro" }))).toBe("universal-3-6-pro");
  });

  it("asks Deepgram for British English", () => {
    const url = new URL(deepgramWsUrl("api.eu.deepgram.com", env({})));
    expect(url.searchParams.get("language")).toBe("en-GB");
  });

  it("leaves medical mode off unless it is configured", () => {
    // The client's own testing found it traded general accuracy for a mild
    // gain on medical terms, so it is a setting rather than a default.
    const off = new URL(assemblyAiWsUrl("streaming.eu.assemblyai.com", "tok", env({})));
    expect(off.searchParams.get("domain")).toBeNull();

    const on = new URL(
      assemblyAiWsUrl("streaming.eu.assemblyai.com", "tok", env({ ASSEMBLYAI_DOMAIN: "medical-v1" })),
    );
    expect(on.searchParams.get("domain")).toBe("medical-v1");
  });

  it("declares the sample rate and encoding the PCM tap produces", () => {
    const url = new URL(assemblyAiWsUrl("streaming.eu.assemblyai.com", "tok", env({})));
    expect(url.searchParams.get("encoding")).toBe("pcm_s16le");
    expect(url.searchParams.get("sample_rate")).toBe("16000");
  });
});

describe("which bytes each vendor is sent", () => {
  it("sends the recorder's output to Deepgram", () => {
    expect(audioFormatFor("deepgram")).toBe("webm-opus");
  });

  it("sends raw PCM to AssemblyAI", () => {
    // Verified against the browser: Chrome's MediaRecorder emits WebM, which
    // AssemblyAI does not accept, and Chrome cannot produce Ogg.
    expect(audioFormatFor("assemblyai")).toBe("pcm-s16le");
  });
});

describe("the session endpoint", () => {
  const fn = () => readFileSync(join(ROOT, "supabase/functions/streaming-session/index.ts"), "utf8");

  it("never returns a long-lived key for the token-based vendor", () => {
    // The function this replaces returned the raw Deepgram API key to the
    // browser, where any signed-in user could read it from the network tab.
    const src = fn();
    expect(src).toMatch(/mintAssemblyAiToken/);
    expect(src).toMatch(/expires_in_seconds/);
  });

  it("checks the privacy controls before issuing a session", () => {
    expect(fn()).toMatch(/hasRequiredPrivacyControls\(vendor, session\.wsUrl\)/);
  });

  it("refuses a non-EU host rather than warning about it", () => {
    // The previous implementation logged a warning and issued the session
    // anyway, which meant a misconfiguration sent patient audio out of the
    // EEA with nothing to stop it.
    const src = fn();
    expect(src).toMatch(/if \(!isEuHost\(vendor, host\)\)/);
    expect(src).toMatch(/Refusing to issue a session/);
  });

  it("requires an authenticated caller before reaching a vendor", () => {
    const src = fn();
    const authAt = src.indexOf("supabase.auth.getUser");
    // The call site, not the import at the top of the file.
    const vendorAt = src.indexOf("resolveVendors(env)");
    expect(authAt).toBeGreaterThan(-1);
    expect(authAt).toBeLessThan(vendorAt);
  });

  it("does not let a missing fallback break the primary path", () => {
    expect(fn()).toMatch(/fallback \$\{fallback\} unavailable/);
  });
});
