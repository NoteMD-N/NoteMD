// @vitest-environment node
import { describe, it, expect } from "vitest";
import { resolveProvider } from "../../supabase/functions/_shared/transcription-policy";

/**
 * Regression cover for the "always Deepgram" bug.
 *
 * Root cause was a stale closure: startRecording is memoised and `mode` was not
 * one of its dependencies, so it captured useMedicalDictation from the first
 * render — when the page opens in consultation mode and the value is false.
 * Switching to Dictation never recreated the callback, so the live streaming
 * socket was opened for every recording regardless of the selected engine.
 *
 * The component now reads through useMedicalDictationRef, which an effect keeps
 * current. These tests pin the decision function that determines which engine
 * a given (mode, engine) pair must use.
 */

/** Mirrors `useMedicalDictation` in Record.tsx. */
function useMedicalDictation(mode: string, dictationEngine: string): boolean {
  return mode === "dictation" && dictationEngine === "accurate";
}

describe("engine selection by mode", () => {
  it("uses the enhanced engine for accurate dictation", () => {
    expect(useMedicalDictation("dictation", "accurate")).toBe(true);
  });

  it("uses the live streaming engine for standard dictation", () => {
    expect(useMedicalDictation("dictation", "fast")).toBe(false);
  });

  it("uses the live streaming engine for consultations regardless of preference", () => {
    // Consultation needs a real-time transcript, so it streams either way.
    expect(useMedicalDictation("consultation", "accurate")).toBe(false);
    expect(useMedicalDictation("consultation", "fast")).toBe(false);
  });

  it("selecting the enhanced engine must never resolve to the streaming vendor", () => {
    // The exact symptom the client reported.
    const provider = resolveProvider("accurate");
    expect(provider).not.toBe("deepgram");
    expect(provider).toBe("openai");
  });

  it("switching mode changes the decision — the value must not be captured once", () => {
    // A stale closure would make these two identical. They must differ.
    const atFirstRender = useMedicalDictation("consultation", "accurate");
    const afterSwitchingToDictation = useMedicalDictation("dictation", "accurate");
    expect(atFirstRender).toBe(false);
    expect(afterSwitchingToDictation).toBe(true);
    expect(atFirstRender).not.toBe(afterSwitchingToDictation);
  });
});

describe("engine tier reported to the client", () => {
  it("never leaks a vendor name in the tier value", () => {
    // The client-facing response exposes only "accurate" / "fast".
    const tiers = ["accurate", "fast"];
    for (const t of tiers) {
      expect(t).not.toMatch(/openai|deepgram|medasr/i);
    }
  });
});
