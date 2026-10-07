// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  closeMessage,
  keepAliveMessage,
  parseMessage,
  usesRecorderOutput,
} from "@/lib/streaming/protocol";
import { TARGET_SAMPLE_RATE, encodeForVendor, floatTo16BitPcm, resample } from "@/lib/streaming/pcm";

/**
 * Two vendors, two wire formats, one transcript.
 *
 * The failure these guard against is not a crash. A misread message produces a
 * transcript that looks plausible and is wrong — a turn repeated three times,
 * an unpunctuated copy followed by a punctuated one, or speech transcribed at
 * the wrong speed. None of that raises an error anywhere.
 */

describe("reading Deepgram's messages", () => {
  const results = (transcript: string, isFinal: boolean) =>
    JSON.stringify({ type: "Results", is_final: isFinal, channel: { alternatives: [{ transcript }] } });

  it("takes a final result as text to keep", () => {
    expect(parseMessage("deepgram", results("Patient reports chest pain", true))).toEqual({
      kind: "final",
      text: "Patient reports chest pain",
    });
  });

  it("takes a non-final result as text that will be revised", () => {
    expect(parseMessage("deepgram", results("Patient reports chest", false))).toEqual({
      kind: "interim",
      text: "Patient reports chest",
    });
  });

  it("ignores an empty or whitespace transcript", () => {
    expect(parseMessage("deepgram", results("", true))).toBeNull();
    expect(parseMessage("deepgram", results("   ", true))).toBeNull();
  });

  it("ignores messages that are not results", () => {
    expect(parseMessage("deepgram", JSON.stringify({ type: "Metadata" }))).toBeNull();
    expect(parseMessage("deepgram", JSON.stringify({ type: "UtteranceEnd" }))).toBeNull();
  });

  it("surfaces a reported error rather than swallowing it", () => {
    const msg = JSON.stringify({ type: "Error", description: "Audio decode failed" });
    expect(parseMessage("deepgram", msg)).toEqual({ kind: "error", message: "Audio decode failed" });
  });
});

describe("reading AssemblyAI's messages", () => {
  const turn = (transcript: string, endOfTurn: boolean, formatted = false) =>
    JSON.stringify({ type: "Turn", transcript, end_of_turn: endOfTurn, turn_is_formatted: formatted });

  it("treats a turn in progress as text that will be revised", () => {
    expect(parseMessage("assemblyai", turn("Patient reports chest", false))).toEqual({
      kind: "interim",
      text: "Patient reports chest",
    });
  });

  it("does not append an unformatted turn that a formatted copy will follow", () => {
    // The turn transcript is cumulative and arrives twice — once settled, once
    // punctuated. Taking the first as final would put an unpunctuated copy in
    // the note and then a punctuated one after it.
    expect(parseMessage("assemblyai", turn("patient reports chest pain", true, false))).toEqual({
      kind: "interim",
      text: "patient reports chest pain",
    });
  });

  it("takes the formatted end of a turn as the text to keep", () => {
    expect(parseMessage("assemblyai", turn("Patient reports chest pain.", true, true))).toEqual({
      kind: "final",
      text: "Patient reports chest pain.",
    });
  });

  it("appends each turn once across a realistic sequence", () => {
    // The whole risk of a cumulative protocol: a turn revised five times must
    // contribute one sentence, not five.
    const sequence = [
      turn("Patient", false),
      turn("Patient reports", false),
      turn("Patient reports chest pain", false),
      turn("patient reports chest pain", true, false),
      turn("Patient reports chest pain.", true, true),
      turn("Started", false),
      turn("Started three days ago.", true, true),
    ];
    const finals: string[] = [];
    for (const raw of sequence) {
      const event = parseMessage("assemblyai", raw);
      if (event?.kind === "final") finals.push(event.text);
    }
    expect(finals).toEqual(["Patient reports chest pain.", "Started three days ago."]);
  });

  it("ignores session metadata", () => {
    expect(parseMessage("assemblyai", JSON.stringify({ type: "Begin", id: "x" }))).toBeNull();
    expect(parseMessage("assemblyai", JSON.stringify({ type: "Termination" }))).toBeNull();
  });

  it("surfaces a reported error", () => {
    expect(parseMessage("assemblyai", JSON.stringify({ type: "Error", error: "Invalid token" }))).toEqual({
      kind: "error",
      message: "Invalid token",
    });
  });
});

describe("surviving a message we do not understand", () => {
  it("never throws on malformed input", () => {
    for (const vendor of ["deepgram", "assemblyai"] as const) {
      for (const raw of ["", "not json", "null", "[]", "42", '{"type":null}', '{"type":"Turn"}']) {
        expect(() => parseMessage(vendor, raw)).not.toThrow();
        expect(parseMessage(vendor, raw)).toBeNull();
      }
    }
  });
});

describe("session control messages", () => {
  it("keeps a Deepgram socket alive through a silence", () => {
    // Dictation has long pauses — thinking, examining — and a socket closed
    // for idleness mid-consultation loses the rest of the transcript.
    expect(keepAliveMessage("deepgram")).toBe(JSON.stringify({ type: "KeepAlive" }));
  });

  it("sends nothing to a vendor that documents no keepalive", () => {
    // An unrecognised frame risks a protocol error, which is worse than the
    // idleness it would prevent.
    expect(keepAliveMessage("assemblyai")).toBeNull();
  });

  it("asks each vendor to flush its held text on close", () => {
    expect(closeMessage("deepgram")).toContain("CloseStream");
    expect(closeMessage("assemblyai")).toContain("Terminate");
  });
});

describe("which vendor can be fed the recorder's output", () => {
  it("sends recorder output to Deepgram", () => {
    expect(usesRecorderOutput({ audioFormat: "webm-opus" })).toBe(true);
  });

  it("does not send recorder output to a PCM vendor", () => {
    // Chrome's MediaRecorder produces WebM-encapsulated Opus, which AssemblyAI
    // does not accept, and Chrome cannot produce Ogg. Sending it anyway leaves
    // the socket open and the transcript empty.
    expect(usesRecorderOutput({ audioFormat: "pcm-s16le" })).toBe(false);
  });
});

describe("encoding microphone samples", () => {
  it("maps the full range without wrapping at the extremes", () => {
    // A wrapped sample flips loud-positive to loud-negative and is heard as a
    // click; on a clipped recording that would be every peak.
    const pcm = floatTo16BitPcm(new Float32Array([0, 1, -1, 2, -2]));
    expect(pcm[0]).toBe(0);
    expect(pcm[1]).toBe(32767);
    expect(pcm[2]).toBe(-32768);
    expect(pcm[3]).toBe(32767);
    expect(pcm[4]).toBe(-32768);
  });

  it("preserves a quiet signal rather than flattening it to zero", () => {
    const pcm = floatTo16BitPcm(new Float32Array([0.001, -0.001]));
    expect(pcm[0]).toBeGreaterThan(0);
    expect(pcm[1]).toBeLessThan(0);
  });

  it("leaves samples alone when the rate already matches", () => {
    const input = new Float32Array([0.1, 0.2, 0.3]);
    expect(resample(input, 16000, 16000)).toBe(input);
  });

  it("downsamples to the expected length", () => {
    // 48kHz to 16kHz is one sample in three.
    const input = new Float32Array(300).fill(0.5);
    const out = resample(input, 48000, 16000);
    expect(out.length).toBe(100);
    expect(out[0]).toBeCloseTo(0.5, 5);
  });

  it("averages rather than dropping samples", () => {
    // Taking every third sample would alias high frequencies into the speech
    // band. Averaging is a crude low-pass; the test pins that it happens.
    const input = new Float32Array([0, 3, 0, 0, 3, 0]);
    const out = resample(input, 48000, 16000);
    expect(out.length).toBe(2);
    expect(out[0]).toBeCloseTo(1, 5);
    expect(out[1]).toBeCloseTo(1, 5);
  });

  it("produces two bytes per sample at the target rate", () => {
    const input = new Float32Array(480).fill(0.25);
    const buffer = encodeForVendor(input, 48000, TARGET_SAMPLE_RATE);
    expect(buffer.byteLength).toBe(160 * 2);
  });

  it("survives an empty buffer and a nonsense rate", () => {
    expect(resample(new Float32Array(0), 48000, 16000).length).toBe(0);
    expect(() => encodeForVendor(new Float32Array([0.1]), 0, 16000)).not.toThrow();
  });
});
