/**
 * The vendor-specific half of live transcription.
 *
 * Deepgram and AssemblyAI differ in what they send down the socket, what they
 * expect back, and what counts as a finished phrase. Everything else about a
 * streaming session — reconnecting, buffering, keeping the socket alive,
 * guarding against one patient's words reaching another's transcript — is the
 * same for both, so only the differences live here.
 *
 * Kept pure: these functions take a message and return an event. No sockets,
 * no state, no React. That is what makes it possible to test the handling of a
 * vendor's wire format without a vendor.
 */

export type StreamingVendor = "deepgram" | "assemblyai";

/**
 * What the browser needs to open a session. Built server-side and handed over
 * complete, so the client cannot assemble a URL that omits a privacy control
 * or points outside the EEA.
 */
export interface StreamingSession {
  vendor: StreamingVendor;
  wsUrl: string;
  credential: string;
  protocols?: string[];
  audioFormat: "webm-opus" | "pcm-s16le";
  sampleRate?: number;
  model: string;
}

/**
 * A transcription result.
 *
 * `interim` text is replaced as the vendor revises it; `final` text is
 * appended and never revised. Everything else a vendor sends — session
 * metadata, turn boundaries, keepalive acknowledgements — produces no event.
 */
export type TranscriptEvent =
  | { kind: "interim"; text: string }
  | { kind: "final"; text: string };

/** A session-level error the vendor reported on the socket. */
export interface StreamingError {
  kind: "error";
  message: string;
}

export type StreamingMessage = TranscriptEvent | StreamingError | null;

/**
 * Turns one websocket message into an event, or null if it carries nothing we
 * act on.
 *
 * Never throws. A vendor that changes its wire format, or sends something
 * unexpected, must not take down a consultation in progress — an unparseable
 * message is simply not an event.
 */
export function parseMessage(vendor: StreamingVendor, raw: string): StreamingMessage {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!msg || typeof msg !== "object") return null;

  return vendor === "deepgram"
    ? parseDeepgram(msg as Record<string, unknown>)
    : parseAssemblyAi(msg as Record<string, unknown>);
}

/**
 * Deepgram sends `Results` messages carrying alternatives, with `is_final`
 * marking text it will not revise.
 */
function parseDeepgram(msg: Record<string, unknown>): StreamingMessage {
  if (msg.type === "Error" || msg.type === "Warning") {
    const description = typeof msg.description === "string" ? msg.description : "Transcription error";
    return { kind: "error", message: description };
  }
  if (msg.type !== "Results") return null;

  const channel = msg.channel as { alternatives?: Array<{ transcript?: unknown }> } | undefined;
  const transcript = channel?.alternatives?.[0]?.transcript;
  if (typeof transcript !== "string" || !transcript.trim()) return null;

  return msg.is_final === true
    ? { kind: "final", text: transcript }
    : { kind: "interim", text: transcript };
}

/**
 * AssemblyAI's v3 protocol reports a *turn*: a running transcript for the
 * current stretch of speech, revised as it goes, with `end_of_turn` marking
 * the point at which it is settled.
 *
 * The important difference from Deepgram is that the turn transcript is
 * cumulative, not incremental. Appending every message would repeat the whole
 * turn on each revision, so only the end-of-turn message produces final text
 * and everything before it is interim.
 *
 * `turn_is_formatted` matters because the formatted version — punctuation and
 * casing applied — arrives after the unformatted one for the same turn. When
 * formatting is on we take the formatted message as the final, so the
 * transcript does not gain an unpunctuated copy followed by a punctuated one.
 */
function parseAssemblyAi(msg: Record<string, unknown>): StreamingMessage {
  const type = msg.type;

  if (type === "Error") {
    const error = typeof msg.error === "string" ? msg.error : "Transcription error";
    return { kind: "error", message: error };
  }

  if (type !== "Turn") return null;

  const transcript = msg.transcript;
  if (typeof transcript !== "string" || !transcript.trim()) return null;

  const endOfTurn = msg.end_of_turn === true;
  const formatted = msg.turn_is_formatted === true;

  // Settled and punctuated: this is the version that belongs in the note.
  if (endOfTurn && formatted) return { kind: "final", text: transcript };

  // Settled but not yet formatted. A formatted copy of this same turn is
  // coming, so treating this as final would duplicate it.
  if (endOfTurn) return { kind: "interim", text: transcript };

  return { kind: "interim", text: transcript };
}

/**
 * The message that keeps an idle socket open, or null if the vendor needs none.
 *
 * Dictation has long silences — a clinician thinking, or examining a patient —
 * and a socket closed for idleness mid-consultation is a dropped transcript.
 */
export function keepAliveMessage(vendor: StreamingVendor): string | null {
  // AssemblyAI keeps the session open on its own and documents no keepalive
  // frame; sending an unrecognised message would risk a protocol error.
  return vendor === "deepgram" ? JSON.stringify({ type: "KeepAlive" }) : null;
}

/**
 * The message that asks the vendor to finish and flush any held text, so the
 * last words spoken are not lost when the clinician stops.
 */
export function closeMessage(vendor: StreamingVendor): string {
  return vendor === "deepgram"
    ? JSON.stringify({ type: "CloseStream" })
    : JSON.stringify({ type: "Terminate" });
}

/**
 * Whether the vendor can be fed the output of a browser MediaRecorder.
 *
 * Chrome's MediaRecorder produces WebM-encapsulated Opus. Deepgram decodes it.
 * AssemblyAI accepts raw PCM, bare Opus packets, Ogg-Opus or AAC — but not
 * WebM, and Chrome cannot produce Ogg. So AssemblyAI is fed raw PCM tapped
 * from the microphone instead, while the MediaRecorder carries on producing
 * the WebM that is saved and used for enhanced dictation.
 */
export function usesRecorderOutput(session: Pick<StreamingSession, "audioFormat">): boolean {
  return session.audioFormat === "webm-opus";
}
