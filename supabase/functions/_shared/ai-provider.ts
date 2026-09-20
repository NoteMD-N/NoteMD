/**
 * Routing between OpenAI and Azure OpenAI.
 *
 * The two are nearly the same API and differ in three places, all of which
 * this module owns so that no call site has to know which provider it is
 * talking to:
 *
 *   1. The URL. OpenAI addresses a model in the request body and a fixed path
 *      (`/v1/chat/completions`). Azure addresses a *deployment* in the path
 *      and requires an `api-version` query parameter.
 *   2. Authentication. OpenAI uses `Authorization: Bearer`; Azure's documented
 *      header is `api-key`.
 *   3. The model name. On Azure the deployment name is what identifies the
 *      model, and it is chosen by whoever created it — it need not match the
 *      underlying model at all.
 *
 * Selection is by configuration, never by code change: set the Azure
 * environment variables and the functions use Azure. That keeps the migration
 * a deployment step rather than a release, and makes rolling back a matter of
 * unsetting one variable.
 *
 * Deliberately not an abstraction layer over "an AI provider" — the client
 * declined that, and rightly: this is the narrow set of differences that
 * actually exist between these two, expressed once.
 */

export type AiProvider = "openai" | "azure";

export interface AiConfig {
  provider: AiProvider;
  /** Base URL with no trailing slash. */
  base: string;
  apiKey: string;
  /** Azure only; ignored for OpenAI. */
  apiVersion: string;
  /** Azure only; the api-version the audio endpoints require. */
  transcribeApiVersion: string;
  /** Model name (OpenAI) or deployment name (Azure) for each task. */
  letterModel: string;
  fastModel: string;
  transcribeModel: string;
}

/** Azure's audio endpoints are on a different api-version from chat. */
const DEFAULT_AZURE_API_VERSION = "2024-10-21";
const DEFAULT_AZURE_TRANSCRIBE_API_VERSION = "2025-03-01-preview";

type Env = (name: string) => string | undefined;

/**
 * Reads the provider configuration from the environment.
 *
 * Azure is selected when it is fully configured — both an endpoint and a key.
 * A half-configured Azure (endpoint set, key missing) falls back to OpenAI
 * rather than failing at request time: a partial deployment must not take
 * letter generation down.
 */
export function resolveAiConfig(env: Env): AiConfig {
  const azureEndpoint = (env("AZURE_OPENAI_ENDPOINT") || "").trim().replace(/\/+$/, "");
  const azureKey = (env("AZURE_OPENAI_API_KEY") || "").trim();
  const forced = (env("AI_PROVIDER") || "").trim().toLowerCase();

  const azureConfigured = Boolean(azureEndpoint && azureKey);
  const provider: AiProvider =
    forced === "openai" ? "openai" : forced === "azure" || azureConfigured ? "azure" : "openai";

  if (provider === "azure") {
    return {
      provider: "azure",
      base: azureEndpoint,
      apiKey: azureKey,
      apiVersion: (env("AZURE_OPENAI_API_VERSION") || DEFAULT_AZURE_API_VERSION).trim(),
      transcribeApiVersion: (
        env("AZURE_OPENAI_TRANSCRIBE_API_VERSION") || DEFAULT_AZURE_TRANSCRIBE_API_VERSION
      ).trim(),
      // Defaults match the deployment names agreed with the client, so a
      // correctly-named deployment needs no further configuration.
      letterModel: (env("AZURE_OPENAI_LETTER_DEPLOYMENT") || "gpt-4o").trim(),
      fastModel: (env("AZURE_OPENAI_FAST_DEPLOYMENT") || "gpt-4o-mini").trim(),
      transcribeModel: (env("AZURE_OPENAI_TRANSCRIBE_DEPLOYMENT") || "gpt-4o-transcribe").trim(),
    };
  }

  return {
    provider: "openai",
    base: (env("OPENAI_API_BASE") || "https://api.openai.com/v1").replace(/\/+$/, ""),
    apiKey: (env("OPENAI_API_KEY") || "").trim(),
    apiVersion: "",
    transcribeApiVersion: "",
    letterModel: (env("OPENAI_LETTER_MODEL") || "gpt-4o").trim(),
    fastModel: (env("OPENAI_FAST_MODEL") || "gpt-4o-mini").trim(),
    transcribeModel: (env("OPENAI_TRANSCRIBE_MODEL") || "gpt-4o-transcribe").trim(),
  };
}

/**
 * URL for a chat completion.
 *
 * `model` is the deployment name on Azure. Passing the wrong one produces a
 * 404 `DeploymentNotFound` rather than a silent fallback, which is the
 * failure mode we want.
 */
export function chatCompletionsUrl(cfg: AiConfig, model: string): string {
  if (cfg.provider === "azure") {
    return `${cfg.base}/openai/deployments/${encodeURIComponent(model)}/chat/completions` +
      `?api-version=${encodeURIComponent(cfg.apiVersion)}`;
  }
  return `${cfg.base}/chat/completions`;
}

/** URL for an audio transcription. */
export function transcriptionsUrl(cfg: AiConfig, model: string): string {
  if (cfg.provider === "azure") {
    return `${cfg.base}/openai/deployments/${encodeURIComponent(model)}/audio/transcriptions` +
      `?api-version=${encodeURIComponent(cfg.transcribeApiVersion)}`;
  }
  return `${cfg.base}/audio/transcriptions`;
}

/**
 * Authentication headers.
 *
 * `api-key` is the documented header for Azure and is what a classic Azure
 * OpenAI resource requires. A Foundry "AI Services" resource — which is what
 * notemd-eu is — happens to accept `Authorization: Bearer` as well, verified
 * against the live endpoint, but that is not true of every resource type. The
 * documented header is sent so the code does not depend on which kind of
 * resource it is pointed at.
 */
export function authHeaders(cfg: AiConfig): Record<string, string> {
  return cfg.provider === "azure"
    ? { "api-key": cfg.apiKey }
    : { Authorization: `Bearer ${cfg.apiKey}` };
}

/**
 * Where a request was actually processed, from the response headers.
 *
 * Azure returns `x-ms-region`. Recording it turns the residency claim into an
 * observation rather than a configuration setting somebody once made — which
 * is what the assurance evidence needs.
 */
export function processingRegion(headers: Headers): string | null {
  return headers.get("x-ms-region") || null;
}
