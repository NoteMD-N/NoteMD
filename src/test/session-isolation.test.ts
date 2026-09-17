// @vitest-environment node
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * One patient's words must not reach another patient's transcript.
 *
 * Segment transcription is fire-and-forget: a ten-second slice of audio is
 * uploaded, transcribed, and its text appended to the live transcript when it
 * returns. The drain before the review screen waits at most eight seconds, so
 * a slow segment can still be in flight when the clinician has finished,
 * generated a letter, and started recording the next patient. When it landed
 * it appended to whatever transcript was current by then.
 *
 * The fix is a session token captured when the work starts and checked before
 * its result is used. The model below is the same logic, so the failure can be
 * demonstrated rather than merely asserted against.
 */

const ROOT = join(__dirname, "../..");
const record = readFileSync(join(ROOT, "src/pages/Record.tsx"), "utf8");

/** A minimal stand-in for the recorder's transcript state and session token. */
class Recorder {
  transcript = "";
  session = "initial";

  startSession(): string {
    this.transcript = "";
    this.session = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    return this.session;
  }

  /** Begins a unit of async work, capturing the session as the code does. */
  beginSegment(): string {
    return this.session;
  }

  /** Applies a result that may arrive after the session has moved on. */
  applySegment(capturedSession: string, text: string, guarded = true): void {
    if (guarded && this.session !== capturedSession) return;
    this.transcript = this.transcript ? `${this.transcript} ${text}` : text;
  }
}

describe("a late transcription result cannot cross into another consultation", () => {
  it("demonstrates the defect when unguarded", () => {
    const r = new Recorder();
    r.startSession();
    const aliceSegment = r.beginSegment();
    r.applySegment(aliceSegment, "Alice reports chest pain.");

    // Clinician finishes and starts the next patient while that segment is
    // still in flight.
    r.startSession();
    r.applySegment(aliceSegment, "and a three-week history of breathlessness", false);

    expect(r.transcript).toContain("breathlessness");
  });

  it("discards the late result once guarded", () => {
    const r = new Recorder();
    r.startSession();
    const aliceSegment = r.beginSegment();

    r.startSession(); // Bob's consultation begins
    r.applySegment(aliceSegment, "Alice reports chest pain.");

    expect(r.transcript).toBe("");
  });

  it("still applies results that belong to the current session", () => {
    // A guard that discarded everything would also pass the test above.
    const r = new Recorder();
    r.startSession();
    const segment = r.beginSegment();
    r.applySegment(segment, "Patient reports a cough.");
    expect(r.transcript).toBe("Patient reports a cough.");
  });

  it("issues a different token for every session", () => {
    const r = new Recorder();
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) seen.add(r.startSession());
    expect(seen.size).toBe(50);
  });
});

describe("the recorder applies that guard", () => {
  it("rotates the session token when a recording starts", () => {
    const start = record.indexOf("const startRecording");
    const body = record.slice(start, start + 2500);
    expect(body).toMatch(/recordingSessionRef\.current\s*=/);
  });

  it("captures the token before a segment is sent and checks it after", () => {
    const fn = record.slice(
      record.indexOf("const transcribeSegmentAndAppend"),
      record.indexOf("const processAudio"),
    );
    expect(fn).toMatch(/const session = recordingSessionRef\.current;/);
    expect(fn).toMatch(/if \(recordingSessionRef\.current !== session\)/);

    // The check must come before the append, not after it.
    const checkAt = fn.indexOf("recordingSessionRef.current !== session");
    const appendAt = fn.indexOf("transcriptRef.current = next");
    expect(checkAt).toBeGreaterThan(-1);
    expect(appendAt).toBeGreaterThan(-1);
    expect(checkAt).toBeLessThan(appendAt);
  });

  it("applies the same guard to streamed results", () => {
    // A provider commonly emits one last final result as the stream closes,
    // and the socket is not torn down until cleanup runs.
    const fn = record.slice(
      record.indexOf("const attachWebSocketHandlers"),
      record.indexOf("const openWebSocket"),
    );
    expect(fn).toMatch(/const session = recordingSessionRef\.current;/);
    expect(fn).toMatch(/if \(recordingSessionRef\.current !== session\) return;/);
  });
});

describe("duplicate submission", () => {
  it("guards generation with a ref, not a rendered disabled state", () => {
    // Two fast clicks can both land before React re-renders the button, and a
    // duplicate generation writes a second recording row and a second letter.
    expect(record).toMatch(/generationInFlightRef/);
    const handler = record.slice(
      record.indexOf("const handleGenerateFromReview"),
      record.indexOf("const runGenerateFromReview"),
    );
    expect(handler).toMatch(/if \(generationInFlightRef\.current\) return;/);
    expect(handler).toMatch(/generationInFlightRef\.current = true;/);
    expect(handler).toMatch(/finally/);
  });

  it("guards sending the same way", () => {
    // Worse than a duplicate draft: correspondence cannot be recalled.
    const letterView = readFileSync(join(ROOT, "src/pages/LetterView.tsx"), "utf8");
    const handler = letterView.slice(
      letterView.indexOf("const handleSendEmail"),
      letterView.indexOf("const handleRegenerate"),
    );
    expect(handler).toMatch(/if \(sendInFlightRef\.current\) return;/);
    expect(handler).toMatch(/sendInFlightRef\.current = false;/);
  });
});

describe("patient identity cannot change mid-recording", () => {
  it("locks the patient fields while recording or processing", () => {
    // Otherwise a transcript captured against one patient could be attributed
    // to another at the moment the recording row is written.
    expect(record).toMatch(/const canEditPatient = !isRecording && !processing;/);
    const disabledCount = (record.match(/disabled=\{!canEditPatient\}/g) ?? []).length;
    expect(disabledCount, "every patient field must be locked").toBeGreaterThanOrEqual(3);
  });
});
