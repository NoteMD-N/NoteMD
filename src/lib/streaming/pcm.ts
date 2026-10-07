/**
 * Turning microphone samples into the bytes a streaming vendor expects.
 *
 * Browsers hand us 32-bit floats between -1 and 1, at whatever rate the audio
 * hardware runs. AssemblyAI's streaming API takes 16-bit signed little-endian
 * PCM at a rate we declare when the session opens. Getting either part wrong
 * does not fail loudly: the socket stays open, the vendor transcribes
 * something, and the result is garbled or silently pitched — so this is kept
 * pure and tested rather than inlined into the capture path.
 */

/** The rate declared to the vendor when a session opens. */
export const TARGET_SAMPLE_RATE = 16000;

/**
 * Converts float samples to 16-bit signed PCM.
 *
 * Values outside -1..1 are clamped rather than allowed to wrap. A wrapped
 * sample flips from loud-positive to loud-negative and is heard as a click; on
 * a clipped recording that would be every peak.
 */
export function floatTo16BitPcm(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const clamped = Math.max(-1, Math.min(1, input[i]));
    // Asymmetric on purpose: 16-bit signed runs -32768..32767, so the negative
    // and positive sides scale by different maxima.
    out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  return out;
}

/**
 * Resamples to the target rate by averaging each source window.
 *
 * Browsers normally honour a requested AudioContext rate, in which case this
 * is never called. When they do not, the alternative to resampling is sending
 * 48 kHz audio labelled as 16 kHz, which the vendor would transcribe as
 * three-times-too-fast speech — nonsense, with no error anywhere.
 *
 * Averaging rather than picking every nth sample: dropping samples aliases
 * high frequencies down into the speech band, which sounds like a
 * metallic rasp and costs accuracy. Averaging is a crude low-pass, which is
 * the right trade for speech at this cost.
 */
export function resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || input.length === 0) return input;
  if (fromRate <= 0 || toRate <= 0) return input;

  const ratio = fromRate / toRate;
  const outLength = Math.floor(input.length / ratio);
  const out = new Float32Array(outLength);

  for (let i = 0; i < outLength; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(Math.floor((i + 1) * ratio), input.length);
    let sum = 0;
    let count = 0;
    for (let j = start; j < end; j++) {
      sum += input[j];
      count++;
    }
    out[i] = count > 0 ? sum / count : input[start] ?? 0;
  }
  return out;
}

/**
 * Prepares one buffer of microphone samples for the socket.
 *
 * Resamples first, then converts: converting first would quantise to 16 bits
 * and then average those values, losing precision for no reason.
 */
export function encodeForVendor(
  input: Float32Array,
  sourceRate: number,
  targetRate: number = TARGET_SAMPLE_RATE,
): ArrayBuffer {
  const resampled = resample(input, sourceRate, targetRate);
  return floatTo16BitPcm(resampled).buffer as ArrayBuffer;
}
