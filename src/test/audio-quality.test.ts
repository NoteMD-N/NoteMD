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
  SEGMENT_MAX_MS,
  SEGMENT_MIN_MS,
  SEGMENT_PAUSE_MS,
  shouldCutSegment,
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

/**
 * Where the end-of-recording hallucinations came from.
 *
 * Segments were cut on a fixed ten-second clock. A clinician who says one
 * sentence and then pauses to examine handed the model two seconds of speech
 * and eight of silence — and a Whisper-family model fills silence with
 * plausible invented text rather than returning nothing. The tail was longest
 * at the end of a recording, which is exactly where the client saw it.
 */
describe("ending a segment at the pause rather than the clock", () => {
  it("cuts once a speaker has stopped", () => {
    expect(shouldCutSegment({
      elapsedMs: 4000, msSinceSpeech: SEGMENT_PAUSE_MS, hadSpeech: true,
    })).toBe(true);
  });

  it("does not cut at an ordinary breath mid-sentence", () => {
    // A pause between words is not the end of an utterance.
    expect(shouldCutSegment({
      elapsedMs: 4000, msSinceSpeech: 400, hadSpeech: true,
    })).toBe(false);
  });

  it("never cuts a segment that has heard nothing", () => {
    // Otherwise a quiet stretch produces a stream of empty segments, each one
    // a request and each one a chance for the model to invent something.
    expect(shouldCutSegment({
      elapsedMs: 9000, msSinceSpeech: 9000, hadSpeech: false,
    })).toBe(false);
  });

  it("still cuts at the ceiling, so a continuous talker is transcribed as they go", () => {
    expect(shouldCutSegment({
      elapsedMs: SEGMENT_MAX_MS, msSinceSpeech: 0, hadSpeech: true,
    })).toBe(true);
  });

  it("does not cut a segment too short to hold an utterance", () => {
    expect(shouldCutSegment({
      elapsedMs: SEGMENT_MIN_MS - 1, msSinceSpeech: 5000, hadSpeech: true,
    })).toBe(false);
  });

  it("keeps the silent tail short across a realistic dictation", () => {
    // One sentence, then a long pause — the shape that produced the problem.
    // The segment must close near the end of the speech, not eight seconds
    // later.
    let elapsed = 0;
    let cutAt: number | null = null;
    for (let t = 250; t <= 10000; t += 250) {
      elapsed = t;
      const msSinceSpeech = t <= 2000 ? 0 : t - 2000; // speech stops at 2s
      if (shouldCutSegment({ elapsedMs: elapsed, msSinceSpeech, hadSpeech: true })) {
        cutAt = t;
        break;
      }
    }
    expect(cutAt).not.toBeNull();
    // Silence carried into the request, in milliseconds.
    expect(cutAt! - 2000).toBeLessThanOrEqual(SEGMENT_PAUSE_MS + 250);
  });

  it("is wired into the recorder", () => {
    const record = readFileSync(join(ROOT, "src/pages/Record.tsx"), "utf8");
    expect(record).toMatch(/shouldCutSegment\(\{/);
    // Checked often enough to land near the pause rather than the clock.
    expect(record).toMatch(/\}, 250\);/);
  });
});

/**
 * The biasing prompt was removed on 21 October 2026.
 *
 * It listed clinical vocabulary including six drug names, on the theory that
 * it would help the model recognise them. With no speech to condition on
 * these models return the prompt as though it had been dictated — so the
 * names most likely to be fabricated were precisely the ones in the list. A
 * prompt meant to help with drug names was manufacturing them.
 */
describe("no vocabulary is supplied to the transcription model", () => {
  const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
  const fns = ["transcribe-audio", "generate-letter"];

  it("sends no prompt field at all", () => {
    for (const fn of fns) {
      const src = read(`supabase/functions/${fn}/index.ts`);
      expect(src, `${fn} still sends a prompt`).not.toMatch(/form\.append\("prompt"/);
    }
  });

  it("carries no drug names for the model to echo", () => {
    for (const fn of fns) {
      const src = read(`supabase/functions/${fn}/index.ts`);
      const prompt = /const CLINICAL_PROMPT = ([\s\S]*?);\n/.exec(src)?.[1] ?? "";
      for (const drug of ["sumatriptan", "amlodipine", "atorvastatin",
                          "levothyroxine", "salbutamol", "omeprazole"]) {
        expect(prompt, `${fn} prompt still names ${drug}`).not.toContain(drug);
      }
      expect(prompt.replace(/\s|"/g, "")).toBe("");
    }
  });

  it("still sends a language hint, which carries no vocabulary", () => {
    // Not clinical context: it stops short segments being misdetected as
    // another language, and there is nothing in it to echo back.
    for (const fn of fns) {
      expect(read(`supabase/functions/${fn}/index.ts`)).toMatch(/form\.append\("language", "en"\)/);
    }
  });

  it("keeps the degenerate-output check, which does not depend on a prompt", () => {
    // Looping output is still rejected whether or not a prompt was sent.
    expect(assessTranscript("ok ok ok ok ok ok ok ok ok ok ok ok", "")).toEqual({
      usable: false, reason: "degenerate",
    });
  });

  it("treats an empty prompt as nothing to echo, rather than matching everything", () => {
    // The guard must not start rejecting real transcripts now that the
    // prompt it compares against is empty.
    expect(looksLikePromptEcho("The patient reports exertional chest pain today", "")).toBe(false);
    expect(assessTranscript("The patient reports exertional chest pain today", "").usable).toBe(true);
  });
});
