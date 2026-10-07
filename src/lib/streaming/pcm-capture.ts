/**
 * Streams raw PCM from the microphone to a vendor that will not take the
 * recorder's output.
 *
 * This runs *alongside* the MediaRecorder rather than replacing it. The
 * recorder keeps producing the WebM that is saved, used for enhanced dictation
 * and re-transcribed when a segment is lost; this taps the same MediaStream
 * through the Web Audio graph purely to feed the live transcript. Nothing
 * about the stored recording changes.
 *
 * The decisions worth knowing:
 *
 *   - **Failure is not fatal.** If the audio graph cannot be built, the
 *     consultation still records and is still transcribed after Stop. Losing
 *     the live transcript is a degraded session; failing to record is a lost
 *     one.
 *   - **The sample rate is verified, not assumed.** The session URL declares a
 *     rate to the vendor. If the browser gives us a different one and we say
 *     nothing, the vendor transcribes speech at the wrong speed and returns
 *     confident nonsense with no error anywhere.
 */

import { TARGET_SAMPLE_RATE, encodeForVendor } from "./pcm";

export class PcmCapture {
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | null = null;
  private send: ((data: ArrayBuffer) => void) | null = null;

  /** The rate the browser actually gave us, which may not be what we asked. */
  private sourceRate = TARGET_SAMPLE_RATE;

  /** True once a tap is running and delivering frames. */
  get active(): boolean {
    return this.node !== null;
  }

  /**
   * Starts tapping `stream`, passing encoded PCM to `send`.
   *
   * Returns false if the tap could not be started, so the caller can decide
   * what to do rather than discovering a silent transcript later.
   */
  async start(
    stream: MediaStream,
    send: (data: ArrayBuffer) => void,
    targetRate: number = TARGET_SAMPLE_RATE,
  ): Promise<boolean> {
    await this.stop();
    this.send = send;

    try {
      const Ctor = window.AudioContext ?? (window as unknown as {
        webkitAudioContext: typeof AudioContext;
      }).webkitAudioContext;

      // Asking for the target rate lets the browser resample in native code,
      // which is better than anything we would do in JavaScript. It is a
      // request, not a guarantee.
      this.context = new Ctor({ sampleRate: targetRate });
      if (this.context.state === "suspended") await this.context.resume();
      this.sourceRate = this.context.sampleRate;

      if (this.sourceRate !== targetRate) {
        // Not an error: we resample below. Logged because it changes where the
        // work happens and is worth seeing when diagnosing audio quality.
        console.warn(
          `[pcm] AudioContext runs at ${this.sourceRate}Hz, not the requested ${targetRate}Hz. ` +
            "Resampling in the client.",
        );
      }

      await this.context.audioWorklet.addModule("/pcm-worklet.js");

      this.source = this.context.createMediaStreamSource(stream);
      this.node = new AudioWorkletNode(this.context, "pcm-tap", {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        processorOptions: { frameSize: 2048 },
      });

      this.node.port.onmessage = (event: MessageEvent<Float32Array>) => {
        if (!this.send) return;
        try {
          this.send(encodeForVendor(event.data, this.sourceRate, targetRate));
        } catch (err) {
          console.warn("[pcm] Failed to send a frame:", err);
        }
      };

      // No connection to the destination: this is a tap, and routing the
      // microphone to the speakers would feed back in the consulting room.
      this.source.connect(this.node);
      return true;
    } catch (err) {
      console.error("[pcm] Could not start the microphone tap:", err);
      await this.stop();
      return false;
    }
  }

  async stop(): Promise<void> {
    if (this.node) {
      this.node.port.onmessage = null;
      try { this.node.disconnect(); } catch { /* already torn down */ }
      this.node = null;
    }
    if (this.source) {
      try { this.source.disconnect(); } catch { /* already torn down */ }
      this.source = null;
    }
    if (this.context) {
      try { await this.context.close(); } catch { /* already closed */ }
      this.context = null;
    }
    this.send = null;
  }
}
