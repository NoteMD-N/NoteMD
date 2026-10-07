/**
 * Microphone tap for vendors that take raw PCM.
 *
 * Served as a static file rather than built from a blob URL: the Content
 * Security Policy allows scripts from 'self' only, and a blob: worklet would
 * need script-src widened — a poor trade for saving one file.
 *
 * Runs on the audio thread, so it does as little as possible. It buffers the
 * 128-sample render quanta the browser delivers into larger frames and posts
 * those to the main thread, which does the conversion and the sending. Posting
 * every quantum would be about 375 messages a second; buffering makes it
 * roughly twenty, with latency the clinician cannot perceive.
 */
class PcmTapProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const frameSize = options?.processorOptions?.frameSize ?? 2048;
    this.frame = new Float32Array(frameSize);
    this.filled = 0;
  }

  process(inputs) {
    // A disconnected or not-yet-ready source gives no channels. Returning true
    // keeps the processor alive for when it does.
    const channel = inputs[0]?.[0];
    if (!channel) return true;

    for (let i = 0; i < channel.length; i++) {
      this.frame[this.filled++] = channel[i];
      if (this.filled === this.frame.length) {
        // Transfer a copy: the frame is reused immediately, and transferring
        // it would detach the buffer we are still writing into.
        const copy = this.frame.slice(0);
        this.port.postMessage(copy, [copy.buffer]);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor("pcm-tap", PcmTapProcessor);
