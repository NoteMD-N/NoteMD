/**
 * Keeping a segmented transcript complete and in order.
 *
 * Enhanced dictation does not stream. The audio is cut into ~10 second
 * segments, each uploaded and transcribed independently, and the returned text
 * is appended to the transcript the clinician is watching. Those requests run
 * concurrently and finish in whatever order the network allows, which creates
 * two failures that both read, to a clinician, as "it missed what I said":
 *
 *   1. **Out of order.** A segment that takes four seconds lands after the one
 *      recorded ten seconds later, so two sentences swap places. Nothing is
 *      lost, but the record of the consultation is wrong, and wrong in a way
 *      that is invisible once the words are on screen.
 *
 *   2. **Dropped.** A segment whose upload or transcription fails takes ten
 *      seconds of the consultation with it. The transcript simply continues,
 *      with no gap a reader could notice.
 *
 * This tracks the order and the gaps. Text is released for appending only once
 * every earlier segment has settled, and a segment that fails is recorded as a
 * gap so the caller can recover the audio rather than quietly ship an
 * incomplete note.
 *
 * Appending in order rather than rebuilding the whole transcript is deliberate:
 * the clinician can edit while recording, and a rebuild would silently discard
 * what they had typed.
 */

export class SegmentAssembler {
  /** The next sequence number to hand out. */
  private issued = 0;
  /** The next sequence number whose text may be appended. */
  private cursor = 0;
  /** Settled but not yet releasable: text, or null for a gap. */
  private settled = new Map<number, string | null>();
  /** Sequence numbers recorded as lost. */
  private lost: number[] = [];

  /**
   * Claims the next sequence number.
   *
   * Called when a segment is cut, on the single thread that cuts them, so the
   * numbers follow the order the words were spoken.
   */
  claim(): number {
    return this.issued++;
  }

  /** Sequence numbers claimed but not yet settled — still in flight. */
  get outstanding(): number[] {
    const out: number[] = [];
    for (let seq = this.cursor; seq < this.issued; seq++) {
      if (!this.settled.has(seq)) out.push(seq);
    }
    return out;
  }

  /** Sequence numbers whose audio never made it into the transcript. */
  get gaps(): readonly number[] {
    return this.lost;
  }

  /** True when some of the consultation is known to be missing. */
  get hasGaps(): boolean {
    return this.lost.length > 0;
  }

  /**
   * Records a segment's text and returns whatever may now be appended, in
   * order. An empty string means the segment held nothing to add — silence
   * the model declined, which is not a gap.
   */
  resolve(seq: number, text: string): string[] {
    return this.settle(seq, text);
  }

  /**
   * Records that a segment's audio could not be transcribed.
   *
   * The sequence is counted as a gap and the cursor moves past it, so the
   * rest of the transcript is not held up behind a segment that will never
   * arrive.
   */
  fail(seq: number): string[] {
    return this.settle(seq, null);
  }

  /**
   * Gives up on everything still in flight, counting each as a gap.
   *
   * Called when the clinician has stopped and waiting any longer would hold
   * up the review screen. Returns the text that had already arrived out of
   * order and can now be released.
   */
  abandonOutstanding(): string[] {
    let released: string[] = [];
    for (const seq of this.outstanding) {
      released = released.concat(this.settle(seq, null));
    }
    return released;
  }

  private settle(seq: number, value: string | null): string[] {
    // A duplicate or a late arrival for a sequence already released. Ignoring
    // it is what keeps a retry from appending the same sentence twice.
    if (seq < this.cursor || this.settled.has(seq)) return [];

    this.settled.set(seq, value);

    const released: string[] = [];
    while (this.settled.has(this.cursor)) {
      const settled = this.settled.get(this.cursor)!;
      this.settled.delete(this.cursor);
      if (settled === null) this.lost.push(this.cursor);
      else if (settled.length > 0) released.push(settled);
      this.cursor++;
    }
    return released;
  }
}

/**
 * Joins released segment text onto an existing transcript.
 *
 * Kept here so the spacing rule is tested rather than inlined at the call
 * site, and so an empty transcript does not gain a leading space.
 */
export function appendSegments(transcript: string, pieces: string[]): string {
  return pieces.reduce((acc, piece) => {
    if (!piece) return acc;
    return acc ? `${acc} ${piece}` : piece;
  }, transcript);
}
