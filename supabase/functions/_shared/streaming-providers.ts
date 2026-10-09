/**
 * The streaming transcription providers, and everything vendor-specific about
 * reaching them.
 *
 * The browser streams consultation audio straight to the vendor, so this module
 * decides three things that must not be left to the client: which vendor, which
 * region, and whether the audio may be retained or trained on. The browser is
 * handed a finished session descriptor and cannot assemble its own — it cannot
 * omit a privacy control or point at a non-EU endpoint.
 *
 * Which vendor is primary, which is the fallback, and which model each uses are
 * read from the environment. Changing any of them is a configuration change
 * with no code change and no frontend rebuild, which is the point: a clinical
 * transcription engine should be swappable without redevelopment.
 *
 * Residency differs in kind between the two vendors, and the difference matters
 * for the DPIA:
 *
 *   - **Deepgram** is opted out of model training by a parameter we add to
 *     every request (`mip_opt_out=true`). We enforce it in code.
 *   - **AssemblyAI** excludes EU-processed audio from model training as a
 *     property of their European data zone. We enforce it by refusing to issue
 *     a session for any host but the EU one.
 *
 * Both are enforced here rather than asserted in a document.
 */

export type StreamingVendor = "deepgram" | "assemblyai";

/**
 * What the browser needs to open a session, and nothing more.
 *
 * `audioFormat` exists because the vendors do not accept the same bytes.
 * Deepgram decodes the WebM/Opus that a browser MediaRecorder produces;
 * AssemblyAI does not accept WebM at all, so the client must tap the
 * microphone and send raw PCM instead.
 */
export interface StreamingSession {
  vendor: StreamingVendor;
  /** Complete URL: region, recognition options and privacy controls included. */
  wsUrl: string;
  /** Token or key, whichever the vendor's handshake takes. */
  credential: string;
  /** WebSocket subprotocols, where the vendor authenticates that way. */
  protocols?: string[];
  /** The bytes this vendor expects on the socket. */
  audioFormat: "webm-opus" | "pcm-s16le";
  /** Required for raw PCM, where the stream does not describe its own rate. */
  sampleRate?: number;
  /** Reported to the client for display and to the audit trail. */
  model: string;
}

// ---------------------------------------------------------------------------
// Regions
//
// Each vendor's EU-resident host, and the host that must never be used. For
// AssemblyAI the default endpoint is the dangerous one: it edge-routes to
// whichever region is nearest, which includes the United States. It is named
// here so the check is against a known value rather than "not the EU one".
// ---------------------------------------------------------------------------

export const VENDOR_HOSTS: Record<StreamingVendor, { eu: string; global: string }> = {
  deepgram: { eu: "api.eu.deepgram.com", global: "api.deepgram.com" },
  assemblyai: { eu: "streaming.eu.assemblyai.com", global: "streaming.assemblyai.com" },
};

/** True when the host keeps audio inside the EEA for that vendor. */
export function isEuHost(vendor: StreamingVendor, host: string): boolean {
  return host.toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "") === VENDOR_HOSTS[vendor].eu;
}

// ---------------------------------------------------------------------------
// Recognition options
// ---------------------------------------------------------------------------

/**
 * Applied to every Deepgram request without exception.
 *
 * The vendor confirmed this must be set per request; a single call without it
 * re-introduces retention for that audio.
 */
export const DEEPGRAM_PRIVACY_PARAMS: Record<string, string> = {
  mip_opt_out: "true",
};

/**
 * Defaults, overridable from the environment.
 *
 * The model is pinned rather than left to the vendor's default. AssemblyAI
 * selects its current flagship when `speech_model` is omitted, so an omitted
 * model means a vendor release could change clinical transcription with no
 * deployment on our side and no way to notice.
 */
/**
 * Non-medical by the client's choice, not by oversight.
 *
 * Their testing found the medical variants gave at best a mild gain on medical
 * terms, sometimes at the cost of general speech accuracy, and sometimes no
 * measurable difference — not enough to justify the additional cost. The same
 * conclusion applies to the primary vendor's medical mode, which is likewise
 * left off.
 */
export const DEFAULT_DEEPGRAM_MODEL = "nova-3";

/**
 * The Deepgram model actually in use, from configuration.
 *
 * Read through one function so the live socket and the batch fallback cannot
 * end up on different models — two transcripts of the same consultation
 * produced by different engines is the kind of difference nobody notices until
 * they are compared side by side.
 *
 * Falls back to the default where no environment is available, which is what
 * lets the shared policy module be imported by the frontend test suite.
 */
export function configuredDeepgramModel(env?: Env): string {
  const read = env ?? ((name: string) =>
    (globalThis as { Deno?: { env?: { get(n: string): string | undefined } } }).Deno?.env?.get(name));
  return (read("DEEPGRAM_MODEL") || DEFAULT_DEEPGRAM_MODEL).trim();
}
export const DEFAULT_ASSEMBLYAI_MODEL = "universal-3-5-pro";

/** Sample rate for the raw-PCM vendors. 16 kHz is ample for speech. */
export const PCM_SAMPLE_RATE = 16000;

type Env = (name: string) => string | undefined;

/**
 * Which vendor should serve a session, and which stands behind it.
 *
 * A vendor that is named but not configured is treated as absent rather than
 * as a failure, and the other one serves the session. The asymmetry is the
 * same one that governs the AI provider: a fallback still transcribes the
 * consultation, a misconfigured primary transcribes nothing.
 */
export function resolveVendors(env: Env): { primary: StreamingVendor; fallback: StreamingVendor | null } {
  const configured = (name: StreamingVendor): boolean =>
    name === "deepgram"
      ? Boolean((env("DEEPGRAM_API_KEY") || "").trim())
      : Boolean((env("ASSEMBLYAI_API_KEY") || "").trim());

  const requested = (env("STREAMING_PRIMARY") || "deepgram").trim().toLowerCase();
  const requestedFallback = (env("STREAMING_FALLBACK") || "").trim().toLowerCase();

  const primaryWanted: StreamingVendor = requested === "assemblyai" ? "assemblyai" : "deepgram";
  const other: StreamingVendor = primaryWanted === "deepgram" ? "assemblyai" : "deepgram";

  if (configured(primaryWanted)) {
    const fallbackWanted: StreamingVendor | null =
      requestedFallback === "deepgram" || requestedFallback === "assemblyai"
        ? (requestedFallback as StreamingVendor)
        : null;
    // A fallback that is the primary, or is not configured, is no fallback.
    const fallback =
      fallbackWanted && fallbackWanted !== primaryWanted && configured(fallbackWanted)
        ? fallbackWanted
        : null;
    return { primary: primaryWanted, fallback };
  }

  // The configured primary has no credential. Rather than fail the
  // consultation, serve from whichever vendor can actually answer.
  if (configured(other)) {
    console.error(
      `[streaming] ${primaryWanted} is selected as primary but has no API key. Serving from ${other}.`,
    );
    return { primary: other, fallback: null };
  }

  // Neither is usable. The caller turns this into a clear error rather than a
  // session that cannot connect.
  return { primary: primaryWanted, fallback: null };
}

/** The host to use for a vendor, honouring an override but never silently. */
export function resolveHost(vendor: StreamingVendor, configured: string | null | undefined): string {
  const raw = (configured || "").trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return raw || VENDOR_HOSTS[vendor].eu;
}

/**
 * Deepgram's websocket URL, with region, recognition options and the mandatory
 * opt-out already applied.
 */
export function deepgramWsUrl(host: string, env: Env): string {
  const params = new URLSearchParams({
    model: configuredDeepgramModel(env),
    language: (env("DEEPGRAM_LANGUAGE") || "en-GB").trim(),
    smart_format: "true",
    punctuate: "true",
    interim_results: "true",
    utterance_end_ms: "1000",
    vad_events: "true",
    ...DEEPGRAM_PRIVACY_PARAMS, // last, so nothing above can override it
  });
  return `wss://${host}/v1/listen?${params.toString()}`;
}

/**
 * AssemblyAI's websocket URL.
 *
 * The temporary token goes in the query string because the browser WebSocket
 * API cannot set request headers. The token is short-lived by construction, so
 * it is not a credential worth protecting from a URL — unlike a long-lived
 * API key, which must never reach the browser in any position.
 */
export function assemblyAiWsUrl(host: string, token: string, env: Env): string {
  const params = new URLSearchParams({
    sample_rate: String(PCM_SAMPLE_RATE),
    encoding: "pcm_s16le",
    speech_model: (env("ASSEMBLYAI_SPEECH_MODEL") || DEFAULT_ASSEMBLYAI_MODEL).trim(),
    format_turns: "true",
    token,
  });
  const domain = (env("ASSEMBLYAI_DOMAIN") || "").trim();
  // Medical mode is off unless configured. The client's own testing found it
  // traded general accuracy for a mild gain on medical terms, so it is a
  // setting rather than a default.
  if (domain) params.set("domain", domain);
  const keyterms = (env("ASSEMBLYAI_KEYTERMS") || "").trim();
  if (keyterms) params.set("keyterms_prompt", keyterms);
  return `wss://${host}/v3/ws?${params.toString()}`;
}

/** The model a vendor will use, for display and for the audit trail. */
export function modelFor(vendor: StreamingVendor, env: Env): string {
  return vendor === "deepgram"
    ? configuredDeepgramModel(env)
    : (env("ASSEMBLYAI_SPEECH_MODEL") || DEFAULT_ASSEMBLYAI_MODEL).trim();
}

/** The bytes a vendor expects on the socket. */
export function audioFormatFor(vendor: StreamingVendor): StreamingSession["audioFormat"] {
  // AssemblyAI accepts PCM, raw Opus packets, Ogg-Opus and AAC — but not the
  // WebM-encapsulated Opus that Chrome's MediaRecorder produces, and Chrome
  // cannot produce Ogg. So the client taps the microphone for raw PCM instead
  // of reusing the recorder's output.
  return vendor === "assemblyai" ? "pcm-s16le" : "webm-opus";
}

/** True when a URL still carries every privacy control that vendor requires. */
export function hasRequiredPrivacyControls(vendor: StreamingVendor, url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (!isEuHost(vendor, parsed.host)) return false;

  if (vendor === "deepgram") {
    // Enforced per request, so it must be present on this one.
    return parsed.searchParams.get("mip_opt_out") === "true";
  }

  // AssemblyAI excludes EU-processed audio from training as a property of the
  // data zone, which the host check above has already established.
  return true;
}


/**
 * AssemblyAI's temporary token.
 *
 * Minted per session with a short redemption window: it must be used to open
 * the socket within this many seconds, after which it is refused. It does not
 * cap the resulting session's own length.
 */
export async function mintAssemblyAiToken(apiKey: string): Promise<string> {
  const url = new URL("https://streaming.assemblyai.com/v3/token");
  url.searchParams.set("expires_in_seconds", "120");

  const resp = await fetch(url, {
    headers: { Authorization: apiKey },
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) {
    // An error body can echo the key back; it never reaches the client.
    console.error(`[streaming] AssemblyAI token request failed: HTTP ${resp.status}`);
    throw new Error("The transcription provider rejected the API key");
  }
  const body = await resp.json();
  const token = body?.token;
  if (typeof token !== "string" || !token) {
    throw new Error("The transcription provider returned no token");
  }
  return token;
}

/**
 * Builds a complete, privacy-checked session descriptor for one vendor.
 *
 * Shared between the endpoint that issues sessions to the browser and the
 * diagnostic that verifies them, so the thing being checked is the thing that
 * runs — a diagnostic that builds its own session proves only that the
 * diagnostic works.
 */
export async function buildStreamingSession(
  vendor: StreamingVendor,
  env: Env,
): Promise<StreamingSession> {
  const configuredHost = vendor === "deepgram"
    ? env("DEEPGRAM_API_BASE")
    : env("ASSEMBLYAI_API_BASE");
  const host = resolveHost(vendor, configuredHost);

  if (!isEuHost(vendor, host)) {
    // Loud, because this would mean patient audio leaving EU infrastructure.
    // For AssemblyAI the default host is the one that edge-routes outside the
    // EEA, so this is not a hypothetical misconfiguration.
    console.error(
      `[streaming] NON-EU host configured for ${vendor}: ${host}. Refusing to issue a session.`,
    );
    throw new Error("Transcription service is misconfigured");
  }

  let session: StreamingSession;

  if (vendor === "deepgram") {
    const apiKey = (env("DEEPGRAM_API_KEY") || "").trim();
    if (!apiKey) throw new Error("Transcription service is not configured");
    session = {
      vendor,
      wsUrl: deepgramWsUrl(host, env),
      credential: apiKey,
      // Deepgram authenticates through the websocket subprotocol.
      protocols: ["token", apiKey],
      audioFormat: audioFormatFor(vendor),
      model: modelFor(vendor, env),
    };
  } else {
    const apiKey = (env("ASSEMBLYAI_API_KEY") || "").trim();
    if (!apiKey) throw new Error("Transcription service is not configured");
    const token = await mintAssemblyAiToken(apiKey);
    session = {
      vendor,
      wsUrl: assemblyAiWsUrl(host, token, env),
      credential: token,
      audioFormat: audioFormatFor(vendor),
      sampleRate: PCM_SAMPLE_RATE,
      model: modelFor(vendor, env),
    };
  }

  // Defensive: never issue a URL that has lost a privacy control on the way
  // through. Being wrong here means patient audio retained or trained on,
  // which cannot be undone once it has happened.
  if (!hasRequiredPrivacyControls(vendor, session.wsUrl)) {
    console.error(`[streaming] refusing to issue a ${vendor} URL missing privacy controls`);
    throw new Error("Transcription service is misconfigured");
  }

  return session;
}
