// @vitest-environment node
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SegmentAssembler, appendSegments } from "@/lib/segment-assembly";

/**
 * Enhanced dictation transcribes ~10 second segments concurrently, so results
 * arrive in network order rather than spoken order, and a segment whose
 * request fails takes ten seconds of the consultation with it.
 *
 * Both failures are invisible in the finished text: the transcript runs on and
 * the letter reads normally. These tests pin down the two guarantees that
 * replace that — order is preserved, and loss is recorded rather than ignored.
 */

const ROOT = join(__dirname, "../..");

describe("assembling a segmented transcript", () => {
  it("hands out sequence numbers in the order segments are cut", () => {
    const a = new SegmentAssembler();
    expect([a.claim(), a.claim(), a.claim()]).toEqual([0, 1, 2]);
  });

  it("releases text immediately when it arrives in order", () => {
    const a = new SegmentAssembler();
    const [s0, s1] = [a.claim(), a.claim()];
    expect(a.resolve(s0, "The patient reports chest pain")).toEqual([
      "The patient reports chest pain",
    ]);
    expect(a.resolve(s1, "on exertion")).toEqual(["on exertion"]);
  });

  it("holds a segment that finishes early until the one before it lands", () => {
    // The failure this prevents: a slow segment makes two sentences swap
    // places, and the consultation is recorded saying something it did not.
    const a = new SegmentAssembler();
    const [s0, s1] = [a.claim(), a.claim()];

    expect(a.resolve(s1, "and the pain resolved")).toEqual([]);
    expect(a.resolve(s0, "We gave GTN")).toEqual([
      "We gave GTN",
      "and the pain resolved",
    ]);
  });

  it("releases a whole run that was waiting behind one segment", () => {
    const a = new SegmentAssembler();
    const seqs = [a.claim(), a.claim(), a.claim(), a.claim()];
    expect(a.resolve(seqs[3], "four")).toEqual([]);
    expect(a.resolve(seqs[1], "two")).toEqual([]);
    expect(a.resolve(seqs[2], "three")).toEqual([]);
    expect(a.resolve(seqs[0], "one")).toEqual(["one", "two", "three", "four"]);
  });

  it("records a lost segment instead of ignoring it", () => {
    const a = new SegmentAssembler();
    const [s0, s1] = [a.claim(), a.claim()];
    a.resolve(s0, "before the gap");
    expect(a.hasGaps).toBe(false);

    a.fail(s1);
    expect(a.hasGaps).toBe(true);
    expect(a.gaps).toEqual([1]);
  });

  it("does not hold the rest of the transcript behind a lost segment", () => {
    // A segment that will never arrive must not block the text after it;
    // otherwise one failure silently truncates everything that followed.
    const a = new SegmentAssembler();
    const [s0, s1, s2] = [a.claim(), a.claim(), a.claim()];
    expect(a.resolve(s2, "third")).toEqual([]);
    expect(a.resolve(s0, "first")).toEqual(["first"]);
    expect(a.fail(s1)).toEqual(["third"]);
    expect(a.gaps).toEqual([1]);
  });

  it("treats a deliberately skipped segment as empty, not as a gap", () => {
    // Silence the level gate declined, or a segment too short to hold
    // speech. Nothing was lost, so nothing should be reported.
    const a = new SegmentAssembler();
    const [s0, s1] = [a.claim(), a.claim()];
    expect(a.resolve(s0, "")).toEqual([]);
    expect(a.resolve(s1, "after the silence")).toEqual(["after the silence"]);
    expect(a.hasGaps).toBe(false);
  });

  it("ignores a duplicate result so a retry cannot append twice", () => {
    const a = new SegmentAssembler();
    const s0 = a.claim();
    expect(a.resolve(s0, "said once")).toEqual(["said once"]);
    expect(a.resolve(s0, "said once")).toEqual([]);
  });

  it("ignores a result that arrives after its segment was written off", () => {
    const a = new SegmentAssembler();
    const [s0, s1] = [a.claim(), a.claim()];
    a.resolve(s0, "first");
    a.fail(s1);
    // The abandoned request finally returns. Appending now would put the
    // words after everything recorded since.
    expect(a.resolve(s1, "late arrival")).toEqual([]);
  });

  it("reports what is still in flight", () => {
    const a = new SegmentAssembler();
    const [s0, s1, s2] = [a.claim(), a.claim(), a.claim()];
    expect(a.outstanding).toEqual([0, 1, 2]);
    a.resolve(s0, "done");
    expect(a.outstanding).toEqual([1, 2]);
    a.resolve(s2, "early");
    expect(a.outstanding).toEqual([1]);
    a.fail(s1);
    expect(a.outstanding).toEqual([]);
  });

  it("counts abandoned segments as gaps and releases what did arrive", () => {
    // At Stop the wait is capped so a stuck request cannot hold up review.
    // What was waiting behind it must still be released, and the stuck one
    // must be counted — not dropped on the floor.
    const a = new SegmentAssembler();
    const [s0, s1, s2] = [a.claim(), a.claim(), a.claim()];
    a.resolve(s0, "first");
    a.resolve(s2, "third");

    expect(a.abandonOutstanding()).toEqual(["third"]);
    expect(a.gaps).toEqual([1]);
  });

  it("is a no-op when nothing is outstanding", () => {
    const a = new SegmentAssembler();
    a.resolve(a.claim(), "all done");
    expect(a.abandonOutstanding()).toEqual([]);
    expect(a.hasGaps).toBe(false);
  });

  it("keeps a full consultation in spoken order under random completion", () => {
    // The real conditions: thirty segments finishing in arbitrary order, two
    // of them lost.
    const a = new SegmentAssembler();
    const spoken = Array.from({ length: 30 }, (_, i) => `sentence ${i}`);
    const seqs = spoken.map(() => a.claim());
    const lost = new Set([7, 22]);

    const order = [...seqs].sort(() => Math.random() - 0.5);
    let assembled: string[] = [];
    for (const seq of order) {
      assembled = assembled.concat(
        lost.has(seq) ? a.fail(seq) : a.resolve(seq, spoken[seq]),
      );
    }

    expect(assembled).toEqual(spoken.filter((_, i) => !lost.has(i)));
    expect([...a.gaps].sort((x, y) => x - y)).toEqual([7, 22]);
  });
});

describe("appending released text", () => {
  it("does not put a space in front of the first words", () => {
    expect(appendSegments("", ["Patient attended"])).toBe("Patient attended");
  });

  it("separates each piece with a single space", () => {
    expect(appendSegments("Patient attended", ["with chest pain", "since Monday"])).toBe(
      "Patient attended with chest pain since Monday",
    );
  });

  it("leaves the clinician's text alone when there is nothing to add", () => {
    expect(appendSegments("their own notes", [])).toBe("their own notes");
    expect(appendSegments("their own notes", [""])).toBe("their own notes");
  });
});

describe("the recording page uses the assembler", () => {
  const record = () => readFileSync(join(ROOT, "src/pages/Record.tsx"), "utf8");

  it("claims a sequence where the segment is cut, not where it is sent", () => {
    // Claiming at send time would order segments by when their request
    // started, which is exactly the ordering bug.
    expect(record()).toMatch(/transcribeSegmentAndAppend\(blob, segmentAssemblerRef\.current\.claim\(\)\)/);
  });

  it("retries a segment before writing it off", () => {
    const src = record();
    expect(src).toMatch(/const ATTEMPTS = 3/);
    expect(src).toMatch(/upsert: true/);
  });

  it("recovers from the full recording when a segment is lost", () => {
    const src = record();
    expect(src).toMatch(/settleSegmentsAndRecover/);
    expect(src).toMatch(/assembler\.hasGaps/);
  });

  it("never overwrites what the clinician typed", () => {
    expect(record()).toMatch(/if \(transcriptEditedRef\.current\) \{/);
  });

  it("sends an unrecoverable gap to review instead of straight to a letter", () => {
    // Skipping review is a convenience. An incomplete transcript is when it
    // must not apply, because the gap is invisible in the finished letter.
    const src = record();
    expect(src).toMatch(/if \(missing > 0\) \{/);
    expect(src).toMatch(/setStage\("review"\)/);
  });

  it("guards the one place text reaches the transcript", () => {
    // Every exit path in the segment handler crosses an await, so each one
    // could append to a transcript that now belongs to a different patient.
    // The check belongs on the choke point, where a later exit path cannot
    // forget it.
    const src = record();
    const fn = src.slice(
      src.indexOf("const transcribeSegmentAndAppend"),
      src.indexOf("const processAudio"),
    );
    const release = fn.slice(fn.indexOf("const release = (pieces"));
    const guardAt = release.indexOf("recordingSessionRef.current !== session");
    const appendAt = release.indexOf("transcriptRef.current = next");
    expect(guardAt).toBeGreaterThan(-1);
    expect(appendAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(appendAt);
  });

  it("tells the clinician how much is missing", () => {
    expect(record()).toMatch(/segmentGaps > 0 &&/);
    expect(record()).toMatch(/could not be transcribed/);
  });
});
