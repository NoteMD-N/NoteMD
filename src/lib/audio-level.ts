/**
 * Microphone level measurement, to keep near-silent audio away from the
 * transcription model.
 *
 * Whisper-family models — which includes the GPT transcription models — do not
 * return nothing when given nothing. Trained on continuous speech, they infer
 * plausible speech from noise, and on silence they frequently emit fluent,
 * confident text that was never said. Sometimes they return the biasing prompt
 * back as if it were dictation.
 *
 * For a clinical note that is the worst available failure: invented content
 * that reads exactly like the real thing, in a document a clinician is about
 * to sign. It is far worse than a missing or garbled transcript, because a gap
 * is obvious and a fabrication is not.
 *
 * The defence is to measure the signal and decline to transcribe what is
 * effectively silence, and to tell the clinician their microphone is too quiet
 * while they can still do something about it.
 *
 * Decibels here are dBFS — decibels relative to full scale — so 0 is the
 * loudest representable signal and values are negative. Ordinary speech into a
 * laptop microphone peaks around -30 to -12 dBFS.
 */

/** Below this, the signal carries no usable speech. */
export const SILENT_DBFS = -55;

/** Below this, speech may be present but is too quiet to transcribe reliably. */
export const LOW_DBFS = -40;

/** A segment whose loudest moment is below this is not sent for transcription. */
export const SEGMENT_FLOOR_DBFS = -50;

/**
 * How long the level must stay low before the clinician is warned.
 *
 * Natural pauses in dictation are silent, and a warning that fires between
 * sentences would be ignored within a day — and then ignored when it mattered.
 */
export const SUSTAINED_LOW_MS = 4000;

export type MicLevelState = "ok" | "low" | "silent";

/**
 * Root-mean-square amplitude of a buffer, as dBFS.
 *
 * RMS rather than peak: a single click should not register as speech, and the
 * perceptual loudness of a passage is what matters for whether a model can
 * transcribe it.
 */
export function rmsToDbfs(samples: Float32Array): number {
  if (samples.length === 0) return -Infinity;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  const rms = Math.sqrt(sum / samples.length);
  // Digital silence is exactly zero and has no logarithm.
  if (rms <= 0) return -Infinity;
  return 20 * Math.log10(rms);
}

/** Where a measured level sits relative to the thresholds above. */
export function classifyLevel(dbfs: number): MicLevelState {
  if (!Number.isFinite(dbfs) || dbfs < SILENT_DBFS) return "silent";
  if (dbfs < LOW_DBFS) return "low";
  return "ok";
}

/**
 * Whether a recorded segment should be sent for transcription.
 *
 * Takes the loudest moment in the segment, not the average: a clinician who
 * says one short sentence in ten seconds produces a low average and a clear
 * peak, and that sentence must not be discarded.
 */
export function shouldTranscribeSegment(peakDbfs: number): boolean {
  return Number.isFinite(peakDbfs) && peakDbfs >= SEGMENT_FLOOR_DBFS;
}

/**
 * Message shown to the clinician, or null when the level is fine.
 *
 * Phrased as something to act on rather than a diagnostic, because it appears
 * mid-consultation and the clinician has seconds to read it.
 */
export function levelWarning(state: MicLevelState): string | null {
  if (state === "silent") {
    return "No sound is reaching the microphone. Check it is connected and not muted — " +
      "nothing is being recorded.";
  }
  if (state === "low") {
    return "The microphone level is very low. Move closer or speak up — quiet audio " +
      "can be transcribed inaccurately.";
  }
  return null;
}

/**
 * Tracks the live microphone level for a stream.
 *
 * Deliberately thin: the decisions live in the pure functions above so they can
 * be tested without a browser audio stack.
 */
export class AudioLevelMonitor {
  private context: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private buffer: Float32Array = new Float32Array(0);
  private timer: number | null = null;

  /** Loudest level observed since the last takePeak(), in dBFS. */
  private peakDbfs = -Infinity;
  /** When the level last rose above the low threshold. */
  private lastOkAt = Date.now();

  currentDbfs = -Infinity;

  start(stream: MediaStream): void {
    this.stop();
    try {
      const Ctor = window.AudioContext ?? (window as unknown as {
        webkitAudioContext: typeof AudioContext;
      }).webkitAudioContext;
      this.context = new Ctor();
      this.analyser = this.context.createAnalyser();
      // Small window: we want a responsive level, not a spectrum.
      this.analyser.fftSize = 1024;
      this.buffer = new Float32Array(this.analyser.fftSize);
      this.source = this.context.createMediaStreamSource(stream);
      this.source.connect(this.analyser);
      this.lastOkAt = Date.now();

      this.timer = window.setInterval(() => this.sample(), 100);
    } catch {
      // Measurement is a safety aid, not a precondition for recording. If the
      // audio stack is unavailable, recording continues unmonitored rather
      // than failing — but the segment gate then has no peak to act on and
      // defaults to transcribing, which is the safe direction.
      this.stop();
    }
  }

  private sample(): void {
    if (!this.analyser) return;
    this.analyser.getFloatTimeDomainData(this.buffer);
    const dbfs = rmsToDbfs(this.buffer);
    this.currentDbfs = dbfs;
    if (dbfs > this.peakDbfs) this.peakDbfs = dbfs;
    if (classifyLevel(dbfs) === "ok") this.lastOkAt = Date.now();
  }

  /** The state to show the clinician, accounting for natural pauses. */
  state(now: number = Date.now()): MicLevelState {
    if (!this.analyser) return "ok"; // unmonitored; do not cry wolf
    if (now - this.lastOkAt < SUSTAINED_LOW_MS) return "ok";
    return classifyLevel(this.currentDbfs);
  }

  /** Loudest level since the previous call, then resets. */
  takePeak(): number {
    const peak = this.peakDbfs;
    this.peakDbfs = -Infinity;
    return peak;
  }

  /** True when no measurement is available, so callers can fail open. */
  get unavailable(): boolean {
    return this.analyser === null;
  }

  stop(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    try {
      this.source?.disconnect();
      void this.context?.close();
    } catch {
      /* already torn down */
    }
    this.context = null;
    this.analyser = null;
    this.source = null;
    this.currentDbfs = -Infinity;
    this.peakDbfs = -Infinity;
  }
}
