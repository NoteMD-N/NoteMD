// @vitest-environment node
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  LOW_DBFS,
  SEGMENT_FLOOR_DBFS,
  SILENT_DBFS,
  classifyLevel,
  levelWarning,
  rmsToDbfs,
  shouldTranscribeSegment,
} from "@/lib/audio-level";
import {
  assessTranscript,
  looksDegenerate,
  looksLikePromptEcho,
} from "../../supabase/functions/_shared/transcription-quality.ts";

/**
 * Whisper-family models do not return nothing when given nothing. Trained on
 * continuous speech, they infer plausible speech from silence and frequently
 * return the biasing prompt back as if it had been dictated.
 *
 * In a clinical note that is the worst available failure: invented content
 * that reads exactly like the real thing, in a document a clinician is about
 * to sign. A gap in a transcript is obvious; a fabrication is not.
 *
 * Two defences, tested here. The client measures the signal and declines to
 * send silence. The server rejects output that bears the marks of having been
 * generated from nothing.
 */

const ROOT = join(__dirname, "../..");

/** A buffer of the given amplitude, as a sine wave rather than a constant. */
function tone(amplitude: number, samples = 1024): Float32Array {
  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i++) out[i] = amplitude * Math.sin((2 * Math.PI * i) / 64);
  return out;
}

describe("measuring the microphone", () => {
  it("reports digital silence as negative infinity, not zero", () => {
    // A zero-amplitude buffer has no logarithm; returning 0 dBFS would read as
    // the loudest possible signal and invert the whole check.
    expect(rmsToDbfs(new Float32Array(1024))).toBe(-Infinity);
  });

  it("measures loudness, not the largest single sample", () => {
    // RMS, so a transient reads far below its own peak: this click touches
    // full scale but measures around -30 dBFS, where a sustained full-scale
    // tone would measure around -3.
    const click = new Float32Array(1024);
    click[0] = 1.0;
    const clickDbfs = rmsToDbfs(click);
    expect(clickDbfs).toBeLessThan(rmsToDbfs(tone(1.0)) - 20);

    // It is still well above the silence floor, and deliberately so. A single
    // loud transient in an otherwise dead recording will pass the segment
    // gate, because the alternative — requiring sustained level — would
    // discard a clinician who says two words and stops. The server-side
    // transcript check is the backstop for that case.
    expect(clickDbfs).toBeGreaterThan(SILENT_DBFS);
  });

  it("places ordinary speech above the thresholds", () => {
    // Speech into a laptop microphone sits around -30 to -12 dBFS.
    expect(classifyLevel(rmsToDbfs(tone(0.1)))).toBe("ok");
    expect(classifyLevel(rmsToDbfs(tone(0.3)))).toBe("ok");
  });

  it("classifies a faint and an absent signal differently", () => {
    // They need different messages: one is "speak up", the other is "your
    // microphone is not working".
    expect(classifyLevel(-45)).toBe("low");
    expect(classifyLevel(-70)).toBe("silent");
    expect(classifyLevel(-Infinity)).toBe("silent");
  });

  it("orders the thresholds coherently", () => {
    expect(SILENT_DBFS).toBeLessThan(LOW_DBFS);
    expect(SEGMENT_FLOOR_DBFS).toBeGreaterThan(SILENT_DBFS);
    expect(SEGMENT_FLOOR_DBFS).toBeLessThan(LOW_DBFS);
  });

  it("tells the clinician what to do, and says nothing when fine", () => {
    expect(levelWarning("ok")).toBeNull();
    expect(levelWarning("low")).toMatch(/closer|speak up/i);
    expect(levelWarning("silent")).toMatch(/not being recorded|muted|connected/i);
  });
});

describe("deciding whether to transcribe a segment", () => {
  it("sends a segment containing speech", () => {
    expect(shouldTranscribeSegment(-20)).toBe(true);
  });

  it("refuses a silent segment", () => {
    expect(shouldTranscribeSegment(-80)).toBe(false);
    expect(shouldTranscribeSegment(-Infinity)).toBe(false);
  });

  it("sends a segment whose loudest moment is quiet but present", () => {
    // One short sentence in ten seconds: low average, clear peak. Discarding
    // it would lose real dictation, which is the failure this must not cause.
    expect(shouldTranscribeSegment(SEGMENT_FLOOR_DBFS + 1)).toBe(true);
  });
});

describe("rejecting output that was not spoken", () => {
  const PROMPT =
    "UK clinical dictation. British English spelling (anaemia, oedema, paediatric, " +
    "haematology, diarrhoea, orthopaedic). Common terms: NHS, GP, mg, mcg, BD, TDS, QDS, PRN, " +
    "PO, IV, IM, SC, ECG, MRI, CT, FBC, U&Es, LFTs, CRP, HbA1c, BP, BMI, PMH, ICE, " +
    "sumatriptan, amlodipine, atorvastatin, levothyroxine, salbutamol, omeprazole.";

  it("rejects the prompt returned as if dictated", () => {
    // The documented failure: with no speech to condition on, the model emits
    // the prompt. In a letter this reads as a convincing clinical fragment.
    expect(looksLikePromptEcho(PROMPT, PROMPT)).toBe(true);
    expect(
      looksLikePromptEcho(
        "anaemia oedema paediatric haematology diarrhoea orthopaedic sumatriptan amlodipine",
        PROMPT,
      ),
    ).toBe(true);
  });

  it("keeps a real dictation that happens to mention those drugs", () => {
    // The whole risk of this check is discarding genuine clinical content.
    const real =
      "The patient has been taking amlodipine five milligrams daily for hypertension " +
      "and we have added atorvastatin twenty milligrams at night. Blood pressure today " +
      "was one forty over eighty-five and she reports no side effects.";
    expect(looksLikePromptEcho(real, PROMPT)).toBe(false);
  });

  it("keeps a short utterance that is mostly drug names", () => {
    // Too short to judge by overlap, and plausibly real.
    expect(looksLikePromptEcho("Continue omeprazole and salbutamol", PROMPT)).toBe(false);
  });

  it("rejects a decoder loop", () => {
    expect(looksDegenerate("thank you thank you thank you thank you thank you thank you")).toBe(true);
  });

  it("keeps clinically legitimate repetition", () => {
    // Systems review is repetitive by nature and must survive.
    const review =
      "No chest pain. No shortness of breath. No palpitations. No ankle swelling. " +
      "No cough. No fever. No weight loss.";
    expect(looksDegenerate(review)).toBe(false);
  });

  it("reports why a transcript was discarded, not merely that it was", () => {
    // The audit trail needs the reason; a clinician seeing nothing must be
    // able to learn it was rejected rather than missed.
    expect(assessTranscript("", PROMPT)).toEqual({ usable: false, reason: "empty" });
    expect(assessTranscript("   ", PROMPT)).toEqual({ usable: false, reason: "empty" });
    expect(assessTranscript(PROMPT, PROMPT).usable).toBe(false);
    expect(assessTranscript("ok ok ok ok ok ok ok ok ok ok ok ok", PROMPT)).toEqual({
      usable: false,
      reason: "degenerate",
    });
  });

  it("passes a genuine transcript through unchanged", () => {
    const real = "Patient attended with a three-week history of exertional chest pain.";
    expect(assessTranscript(`  ${real}  `, PROMPT)).toEqual({ usable: true, text: real });
  });

  it("never edits a transcript, only accepts or rejects it", () => {
    // A quietly cleaned-up transcript is unsafe: the clinician cannot tell
    // which words were theirs.
    const real = "Continue amlodipine. Review in six weeks.";
    const verdict = assessTranscript(real, PROMPT);
    expect(verdict.usable && verdict.text).toBe(real);
  });
});

describe("the defences are wired in", () => {
  it("gates segment upload on the measured peak", () => {
    const record = readFileSync(join(ROOT, "src/pages/Record.tsx"), "utf8");
    expect(record).toMatch(/shouldTranscribeSegment\(peak\)/);
    expect(record).toMatch(/takePeak\(\)/);
  });

  it("sends the segment when no measurement is available", () => {
    // Failing closed here would silently lose dictation on a browser where
    // the audio stack is unavailable.
    const record = readFileSync(join(ROOT, "src/pages/Record.tsx"), "utf8");
    expect(record).toMatch(/monitor && !monitor\.unavailable && !shouldTranscribeSegment/);
  });

  it("warns the clinician while they can still act on it", () => {
    // The warning has to be on screen during recording, not in a log. By the
    // time the letter is drafted it is too late to say it again.
    const record = readFileSync(join(ROOT, "src/pages/Record.tsx"), "utf8");
    expect(record).toMatch(/isRecording && micLevel !== "ok"/);
    expect(record).toMatch(/levelWarning\(micLevel\)/);
    expect(record).toMatch(/role="status"/);
  });

  it("checks transcription output on the server too", () => {
    for (const fn of ["transcribe-audio", "generate-letter"]) {
      const src = readFileSync(
        join(ROOT, "supabase/functions", fn, "index.ts"),
        "utf8",
      );
      expect(src, `${fn} does not assess its transcript`).toMatch(/assessTranscript\(/);
    }
  });
});
