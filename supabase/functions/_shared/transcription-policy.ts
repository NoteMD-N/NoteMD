/**
 * Pure decision logic shared by the Supabase edge functions and the unit tests.
 *
 * Everything in this file must stay dependency-free (no Deno APIs, no network,
 * no Supabase client) so it can be imported unchanged by both the Deno runtime
 * and Vitest. That is what lets the tests exercise the real code path used in
 * production rather than a re-implementation of it.
 *
 * These functions encode two safety properties:
 *
 *  1. ENGINE ROUTING — the transcript the clinician sees must come from the
 *     engine they selected. Silently falling back to a different engine has
 *     produced real confusion for this client before.
 *
 *  2. WYSIWYG — if the clinician has been shown a transcript, the letter must
 *     be generated from exactly those words. The server must never re-run ASR
 *     and quietly substitute different text.
 */

export type Provider = "openai" | "medasr" | "deepgram";

/** Values the client may send for the requested engine. */
export type EngineRequest = string | null | undefined;

/**
 * Decide which transcription provider handles a request.
 *
 * `accurateProvider` comes from the TRANSCRIBE_ACCURATE_PROVIDER env var and
 * lets the accurate engine be repointed (e.g. back to a self-hosted service for
 * a data-residency decision) without a code change.
 */
export function resolveProvider(
  engine: EngineRequest,
  accurateProvider: string | null | undefined = "openai",
): Provider {
  const normalisedEngine = (engine ?? "").toLowerCase();
  const normalisedAccurate = (accurateProvider || "openai").toLowerCase();

  // Explicit opt-in to the legacy self-hosted service.
  if (normalisedEngine === "medasr") return "medasr";

  const wantsAccurate = normalisedEngine === "accurate" || normalisedEngine === "medical";
  if (wantsAccurate) {
    return normalisedAccurate === "openai" ? "openai" : "medasr";
  }

  // "fast", "" and anything unrecognised fall through to the streaming engine.
  return "deepgram";
}

/** The coarse engine tier reported back to the client alongside the provider. */
export function providerTier(provider: Provider): "accurate" | "fast" {
  return provider === "deepgram" ? "fast" : "accurate";
}

/**
 * Values the client may send for `transcript_source`. "client" and "medical"
 * both mean "a human has seen this text"; "medical" is retained for backwards
 * compatibility with builds deployed before the review path was unified.
 */
export function isAuthoritativeTranscriptSource(source: unknown): boolean {
  return source === "client" || source === "medical";
}

export interface ServerTranscriptionInput {
  transcriptSource?: unknown;
  clientTranscript?: string | null;
  isDictation: boolean;
  dictationEngine: string;
}

/**
 * Decide whether the SERVER should run ASR itself.
 *
 * Returning `true` when the clinician has already reviewed a transcript is the
 * failure mode we must avoid: it generates the letter from words the clinician
 * never saw.
 */
export function shouldServerTranscribe(input: ServerTranscriptionInput): boolean {
  const clientTranscript = (input.clientTranscript ?? "").trim();

  // A reviewed transcript is authoritative — never re-transcribe over it.
  if (clientTranscript && isAuthoritativeTranscriptSource(input.transcriptSource)) {
    return false;
  }

  // Nothing usable from the client: the server has to produce the text.
  if (!clientTranscript) return true;

  // Unreviewed dictation on the accurate engine: the client transcript is only
  // a fallback, so prefer a server-side accurate pass.
  if (input.isDictation && input.dictationEngine === "accurate") return true;

  return false;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TemplateSelection {
  /** The clinician explicitly asked for no template at all. */
  noTemplate: boolean;
  /** A real template id to load, or null/undefined when there is none. */
  effectiveTemplateId: string | null | undefined;
  /** Whether the caller supplied a syntactically valid template id. */
  isValidUuid: boolean;
}

/**
 * Interpret the `template_id` field.
 *
 * Guards against a non-UUID sentinel reaching Postgres, which fails with
 * "invalid input syntax for type uuid" and surfaces to users as an opaque
 * "Edge Function returned a non-2xx status code".
 */
export function resolveTemplateSelection(templateId: unknown): TemplateSelection {
  const raw = typeof templateId === "string" ? templateId : undefined;

  if (raw === "none") {
    return { noTemplate: true, effectiveTemplateId: null, isValidUuid: false };
  }
  if (raw === undefined) {
    // Caller didn't express a preference — keep whatever the record already has.
    return { noTemplate: false, effectiveTemplateId: undefined, isValidUuid: false };
  }
  if (UUID_RE.test(raw)) {
    return { noTemplate: false, effectiveTemplateId: raw, isValidUuid: true };
  }
  // Unknown sentinel from an older/newer client: degrade to "no template"
  // rather than crashing on the database cast.
  return { noTemplate: false, effectiveTemplateId: null, isValidUuid: false };
}

/** Upload ceiling for the OpenAI audio transcription endpoint. */
export const OPENAI_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** Whether a blob size is accepted by the OpenAI transcription endpoint. */
export function isTranscribableSize(bytes: number): boolean {
  return bytes > 0 && bytes <= OPENAI_MAX_UPLOAD_BYTES;
}

// ---------------------------------------------------------------------------
// Streaming-provider endpoint (data residency).
//
// The streaming vendor runs regional endpoints. The default host resolves to
// Sacramento, California; the EU host resolves to eu-central-1 (Frankfurt).
// Patient audio must stay on EU infrastructure, so EU is the default here and
// the value is overridable by env for support/diagnostics.
//
//   DEEPGRAM_API_BASE=https://api.eu.deepgram.com   (default)
//   DEEPGRAM_API_BASE=https://api.deepgram.com      (global - NOT EU-resident)
// ---------------------------------------------------------------------------
export const STREAMING_EU_HOST = "api.eu.deepgram.com";
export const STREAMING_GLOBAL_HOST = "api.deepgram.com";

/**
 * Normalise a configured base into a bare host.
 *
 * Accepts a full URL, a scheme-less host, or an empty/missing value, so a
 * mis-set environment variable degrades to the EU host rather than producing a
 * malformed URL that fails at connection time.
 */
export function resolveStreamingHost(configured?: string | null): string {
  const raw = (configured || "").trim();
  if (!raw) return STREAMING_EU_HOST;

  // Strip scheme and any path, then drop a trailing slash.
  const withoutScheme = raw.replace(/^[a-z]+:\/\//i, "");
  const host = withoutScheme.split("/")[0].trim();

  return host || STREAMING_EU_HOST;
}

/** HTTPS base for the pre-recorded/batch endpoint. */
export function streamingHttpUrl(configured: string | null | undefined, path = "v1/listen"): string {
  return `https://${resolveStreamingHost(configured)}/${path.replace(/^\/+/, "")}`;
}

/** WSS base for the real-time endpoint. */
export function streamingWsUrl(configured: string | null | undefined, path = "v1/listen"): string {
  return `wss://${resolveStreamingHost(configured)}/${path.replace(/^\/+/, "")}`;
}

/** True when the configured host is the EU-resident one. */
export function isEuResidentStreamingHost(configured?: string | null): boolean {
  return resolveStreamingHost(configured) === STREAMING_EU_HOST;
}


// ---------------------------------------------------------------------------
// Residency diagnostic verdict.
//
// Correlates the result of probing the configured endpoint with the result of
// probing the global one. Testing only one endpoint cannot distinguish
// "credential is region-locked" from "credential is invalid" — both look like
// a rejection.
// ---------------------------------------------------------------------------
export type ResidencyVerdict =
  | "eu_ok_region_locked"
  | "eu_ok"
  | "not_provisioned"
  | "invalid_key"
  | "unreachable"
  | "not_eu_configured";

export interface ResidencyInput {
  /** Did the configured endpoint respond at all? */
  configuredReachable: boolean;
  /** true = key accepted, false = rejected, null = indeterminate. */
  configuredKeyAccepted: boolean | null;
  /** Same for the global endpoint; null when it was not probed. */
  globalKeyAccepted: boolean | null;
  /** Is the configured host the EU one? */
  euConfigured: boolean;
}

export function resolveResidencyVerdict(input: ResidencyInput): ResidencyVerdict {
  if (!input.configuredReachable) return "unreachable";
  if (!input.euConfigured) return "not_eu_configured";

  if (input.configuredKeyAccepted === true) {
    // Accepted by EU but rejected globally => the credential is EU-scoped.
    return input.globalKeyAccepted === false ? "eu_ok_region_locked" : "eu_ok";
  }

  if (input.configuredKeyAccepted === false) {
    // Rejected by EU but accepted globally => account lacks EU provisioning.
    if (input.globalKeyAccepted === true) return "not_provisioned";
    // Rejected everywhere => the credential itself is the problem.
    return "invalid_key";
  }

  return "unreachable";
}
