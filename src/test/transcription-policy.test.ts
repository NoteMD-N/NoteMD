// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  resolveProvider,
  providerTier,
  isAuthoritativeTranscriptSource,
  shouldServerTranscribe,
  resolveTemplateSelection,
  isTranscribableSize,
  OPENAI_MAX_UPLOAD_BYTES,
} from "../../supabase/functions/_shared/transcription-policy";

describe("resolveProvider — the clinician gets the engine they picked", () => {
  it("routes the accurate engine to OpenAI by default", () => {
    expect(resolveProvider("accurate")).toBe("openai");
  });

  it("treats the legacy 'medical' alias as accurate", () => {
    expect(resolveProvider("medical")).toBe("openai");
  });

  it("routes the fast engine to Deepgram", () => {
    expect(resolveProvider("fast")).toBe("deepgram");
  });

  it("never sends accurate-engine work to Deepgram", () => {
    // The client's core complaint: accurate dictation showing Deepgram text.
    for (const accurateProvider of ["openai", "medasr", "", null, undefined]) {
      expect(resolveProvider("accurate", accurateProvider)).not.toBe("deepgram");
    }
  });

  it("honours an explicit medasr opt-in", () => {
    expect(resolveProvider("medasr")).toBe("medasr");
    // ...even when the accurate engine is pointed at OpenAI.
    expect(resolveProvider("medasr", "openai")).toBe("medasr");
  });

  it("falls back to MedASR when the accurate provider is repointed", () => {
    expect(resolveProvider("accurate", "medasr")).toBe("medasr");
  });

  it("is case-insensitive on both inputs", () => {
    expect(resolveProvider("ACCURATE", "OpenAI")).toBe("openai");
    expect(resolveProvider("Fast")).toBe("deepgram");
  });

  it("defaults unknown or missing engines to the fast tier", () => {
    for (const engine of ["", null, undefined, "banana"]) {
      expect(resolveProvider(engine)).toBe("deepgram");
    }
  });
});

describe("providerTier", () => {
  it("reports OpenAI and MedASR as the accurate tier", () => {
    expect(providerTier("openai")).toBe("accurate");
    expect(providerTier("medasr")).toBe("accurate");
  });

  it("reports Deepgram as the fast tier", () => {
    expect(providerTier("deepgram")).toBe("fast");
  });
});

describe("isAuthoritativeTranscriptSource", () => {
  it("accepts the current and legacy markers", () => {
    expect(isAuthoritativeTranscriptSource("client")).toBe(true);
    expect(isAuthoritativeTranscriptSource("medical")).toBe(true);
  });

  it("rejects anything else", () => {
    for (const v of [undefined, null, "", "server", "openai", 1, {}]) {
      expect(isAuthoritativeTranscriptSource(v)).toBe(false);
    }
  });
});

describe("shouldServerTranscribe — WYSIWYG safety property", () => {
  it("NEVER re-transcribes over a reviewed transcript", () => {
    // This is the property the client asked for: the letter must be generated
    // from the words shown on screen. Assert it across every mode/engine combo.
    for (const isDictation of [true, false]) {
      for (const dictationEngine of ["fast", "accurate"]) {
        for (const transcriptSource of ["client", "medical"]) {
          expect(
            shouldServerTranscribe({
              transcriptSource,
              clientTranscript: "Patient reports right-sided headache.",
              isDictation,
              dictationEngine,
            }),
          ).toBe(false);
        }
      }
    }
  });

  it("transcribes when the client sent nothing at all", () => {
    expect(
      shouldServerTranscribe({
        clientTranscript: "",
        isDictation: false,
        dictationEngine: "fast",
      }),
    ).toBe(true);
  });

  it("treats a whitespace-only transcript as nothing", () => {
    expect(
      shouldServerTranscribe({
        transcriptSource: "client",
        clientTranscript: "   \n\t  ",
        isDictation: false,
        dictationEngine: "fast",
      }),
    ).toBe(true);
  });

  it("prefers a server pass for UNREVIEWED accurate dictation", () => {
    expect(
      shouldServerTranscribe({
        transcriptSource: undefined,
        clientTranscript: "rough draft text",
        isDictation: true,
        dictationEngine: "accurate",
      }),
    ).toBe(true);
  });

  it("trusts an unreviewed fast-dictation transcript rather than re-running ASR", () => {
    expect(
      shouldServerTranscribe({
        transcriptSource: undefined,
        clientTranscript: "live deepgram text",
        isDictation: true,
        dictationEngine: "fast",
      }),
    ).toBe(false);
  });

  it("trusts a consultation transcript captured live", () => {
    expect(
      shouldServerTranscribe({
        transcriptSource: undefined,
        clientTranscript: "consultation text",
        isDictation: false,
        dictationEngine: "accurate",
      }),
    ).toBe(false);
  });
});

describe("resolveTemplateSelection — Ask AI 'No template'", () => {
  it("recognises the 'none' sentinel without touching the database", () => {
    const r = resolveTemplateSelection("none");
    expect(r.noTemplate).toBe(true);
    expect(r.effectiveTemplateId).toBeNull();
    expect(r.isValidUuid).toBe(false);
  });

  it("keeps the existing template when the caller omits the field", () => {
    const r = resolveTemplateSelection(undefined);
    expect(r.noTemplate).toBe(false);
    expect(r.effectiveTemplateId).toBeUndefined();
  });

  it("accepts a valid uuid", () => {
    const id = "3f8a1c2e-9b4d-4e77-8a11-5c6d7e8f9a0b";
    const r = resolveTemplateSelection(id);
    expect(r.noTemplate).toBe(false);
    expect(r.effectiveTemplateId).toBe(id);
    expect(r.isValidUuid).toBe(true);
  });

  it("never passes a non-uuid sentinel through to Postgres", () => {
    // Regression: these previously reached the DB and produced
    // "invalid input syntax for type uuid", surfaced as an opaque non-2xx.
    for (const bad of ["keep", "banana", "12345", "", "null"]) {
      const r = resolveTemplateSelection(bad);
      expect(r.isValidUuid).toBe(false);
      expect(r.effectiveTemplateId).not.toBe(bad);
    }
  });

  it("ignores non-string input", () => {
    for (const v of [null, 42, {}, []]) {
      const r = resolveTemplateSelection(v);
      expect(r.effectiveTemplateId).toBeUndefined();
      expect(r.noTemplate).toBe(false);
    }
  });
});

describe("isTranscribableSize — OpenAI 25MB ceiling", () => {
  it("rejects empty audio", () => {
    expect(isTranscribableSize(0)).toBe(false);
  });

  it("accepts a typical 10s segment and a 30-minute consultation", () => {
    expect(isTranscribableSize(30 * 1024)).toBe(true);
    expect(isTranscribableSize(15 * 1024 * 1024)).toBe(true);
  });

  it("accepts exactly the limit and rejects one byte over", () => {
    expect(isTranscribableSize(OPENAI_MAX_UPLOAD_BYTES)).toBe(true);
    expect(isTranscribableSize(OPENAI_MAX_UPLOAD_BYTES + 1)).toBe(false);
  });
});
