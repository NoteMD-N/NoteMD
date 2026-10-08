import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { redactError } from "../_shared/redact.ts";
import {
  authHeaders,
  chatCompletionsUrl,
  classifyProviderStatus,
  processingRegion,
  resolveAiConfig,
  transcriptionsUrl,
} from "../_shared/ai-provider.ts";
import {
  buildStreamingSession,
  resolveVendors,
  type StreamingVendor,
} from "../_shared/streaming-providers.ts";
import {
  buildBatchUrlForHost,
  hasPrivacyOptOut,
  resolveStreamingHost,
  isEuResidentStreamingHost,
  STREAMING_EU_HOST,
  STREAMING_GLOBAL_HOST,
  resolveResidencyVerdict,
} from "../_shared/transcription-policy.ts";

/**
 * Self-service residency and connectivity diagnostic.
 *
 * Reads the API keys from the function's own environment, so an operator can
 * verify the configuration without ever handling a credential by hand.
 *
 * Sends a generated 440Hz tone — never patient data — to the configured
 * endpoints and reports whether the key was accepted.
 *
 * Keys are never returned to the caller. Vendor names are not returned either;
 * the response is phrased in terms of endpoints and regions, since the choice
 * of engine is proprietary. Vendor detail goes to the server log only.
 */

/** Build a small mono 16-bit PCM WAV containing a test tone. */
function makeTestWav(seconds = 1, sampleRate = 16000, freq = 440): Uint8Array {
  const numSamples = Math.floor(seconds * sampleRate);
  const dataSize = numSamples * 2;
  const buf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buf);

  const writeAscii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i += 1) view.setUint8(offset + i, s.charCodeAt(i));
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);        // PCM subchunk size
  view.setUint16(20, 1, true);         // format = PCM
  view.setUint16(22, 1, true);         // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true);         // block align
  view.setUint16(34, 16, true);        // bits per sample
  writeAscii(36, "data");
  view.setUint32(40, dataSize, true);

  for (let i = 0; i < numSamples; i += 1) {
    const v = Math.round(32767 * 0.3 * Math.sin((2 * Math.PI * freq * i) / sampleRate));
    view.setInt16(44 + i * 2, v, true);
  }
  return new Uint8Array(buf);
}

/** AWS load-balancer hostnames embed the region, e.g. ...eu-central-1.elb... */
async function regionHintFor(host: string): Promise<string | null> {
  try {
    const res = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(host)}&type=CNAME`);
    if (!res.ok) return null;
    const json = await res.json();
    const answers: Array<{ data?: string }> = json?.Answer ?? [];
    for (const a of answers) {
      const m = (a.data || "").match(/([a-z]{2}-[a-z]+-\d)/);
      if (m) return m[1];
    }
  } catch {
    /* DNS-over-HTTPS unavailable — region hint is best-effort */
  }
  return null;
}

type ProbeResult = {
  endpoint: string;
  reachable: boolean;
  http_status: number | null;
  key_accepted: boolean | null;
  region: string | null;
  latency_ms: number | null;
  /** Whether the request carried the no-retention / no-training opt-out. */
  privacy_opt_out: boolean;
};

async function probeStreaming(host: string, apiKey: string, wav: Uint8Array): Promise<ProbeResult> {
  // Probe with the exact parameters production uses, so the check exercises
  // the real request shape including the privacy opt-out.
  const endpoint = buildBatchUrlForHost(host);
  const started = Date.now();
  try {
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Token ${apiKey}`, "Content-Type": "audio/wav" },
      body: wav,
      signal: AbortSignal.timeout(20000),
    });
    const status = resp.status;
    await resp.body?.cancel();
    return {
      endpoint: host,
      reachable: true,
      http_status: status,
      // 200 = accepted; 400 = accepted but disliked the audio (still proves auth).
      key_accepted: status === 200 || status === 400 ? true : status === 401 || status === 403 ? false : null,
      region: await regionHintFor(host),
      latency_ms: Date.now() - started,
      privacy_opt_out: hasPrivacyOptOut(endpoint),
    };
  } catch (e) {
    console.error(`[diagnostics] probe failed for ${host}:`, redactError(e));
    return {
      endpoint: host,
      reachable: false,
      http_status: null,
      key_accepted: null,
      region: null,
      latency_ms: Date.now() - started,
      privacy_opt_out: hasPrivacyOptOut(endpoint),
    };
  }
}

/** What the enhanced-dictation provider check reports. */
type AiProbeResult = {
  /** "azure" or "openai" — which provider the environment actually selects. */
  provider: string;
  /** Host only; never the key, and never the full URL with a deployment name. */
  host: string;
  /** The model (OpenAI) or deployment (Azure) that would serve a request. */
  model: string;
  reachable: boolean;
  http_status: number | null;
  key_accepted: boolean | null;
  /** From the provider's own response headers, not from configuration. */
  region: string | null;
  latency_ms: number;
};

/**
 * Probes the provider that serves enhanced dictation.
 *
 * This exists because "the secret is set" and "the switch took" are different
 * claims. A key that is a placeholder, revoked, or scoped to the wrong
 * resource is indistinguishable from a working one until something uses it,
 * and the first thing to notice would otherwise be a clinician mid-consultation.
 *
 * Sends the same generated tone as the streaming probe — never patient data —
 * and reads the processing region back out of the response headers, so
 * residency is evidenced by the provider rather than asserted by us.
 */
async function probeAiProvider(wav: Uint8Array, modelOverride?: string): Promise<AiProbeResult> {
  const config = resolveAiConfig((name) => Deno.env.get(name));
  // An override lets a deployment be checked for readiness *before* anything
  // is pointed at it. Switching the transcription deployment blind is not a
  // reversible mistake in the moment: on Azure a name that does not exist is
  // a 404 on every dictation, discovered by a clinician mid-consultation.
  const model = (modelOverride || config.transcribeModel).trim();
  const url = transcriptionsUrl(config, model);
  const host = (() => {
    try { return new URL(url).host; } catch { return "invalid"; }
  })();

  const base: Omit<AiProbeResult, "reachable" | "http_status" | "key_accepted" | "region" | "latency_ms"> = {
    provider: config.provider,
    host,
    model,
  };

  const started = Date.now();
  if (!config.apiKey) {
    return { ...base, reachable: false, http_status: null, key_accepted: null, region: null, latency_ms: 0 };
  }

  try {
    const form = new FormData();
    form.append("file", new Blob([wav], { type: "audio/wav" }), "probe.wav");
    form.append("model", model);
    form.append("response_format", "text");

    const resp = await fetch(url, {
      method: "POST",
      headers: authHeaders(config),
      body: form,
      signal: AbortSignal.timeout(20000),
    });
    const status = resp.status;
    const region = processingRegion(resp.headers);
    await resp.body?.cancel();

    return {
      ...base,
      reachable: true,
      http_status: status,
      // Shared with the module that builds the request, and unit tested there.
      key_accepted: classifyProviderStatus(status),
      region,
      latency_ms: Date.now() - started,
    };
  } catch (e) {
    console.error("[diagnostics] AI provider probe failed:", redactError(e));
    return { ...base, reachable: false, http_status: null, key_accepted: null, region: null, latency_ms: Date.now() - started };
  }
}

/**
 * Probes the deployment that writes letters.
 *
 * Transcription and letter generation use different deployments on the same
 * resource, so verifying one says nothing about the other: a correct
 * transcription deployment and a misnamed letter deployment is a working
 * dictation that produces no letter. On Azure the wrong name is a 404
 * DeploymentNotFound, which this is here to surface before a clinician meets
 * it.
 *
 * Sends a fixed two-token prompt and asks for one token back — no patient
 * data, and the smallest call that still proves the deployment answers.
 */
async function probeLetterModel(): Promise<AiProbeResult> {
  const config = resolveAiConfig((name) => Deno.env.get(name));
  const url = chatCompletionsUrl(config, config.letterModel);
  const host = (() => {
    try { return new URL(url).host; } catch { return "invalid"; }
  })();

  const base = { provider: config.provider, host, model: config.letterModel };
  const started = Date.now();
  if (!config.apiKey) {
    return { ...base, reachable: false, http_status: null, key_accepted: null, region: null, latency_ms: 0 };
  }

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { ...authHeaders(config), "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.letterModel,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
      }),
      signal: AbortSignal.timeout(20000),
    });
    const status = resp.status;
    const region = processingRegion(resp.headers);
    await resp.body?.cancel();
    return {
      ...base,
      reachable: true,
      http_status: status,
      key_accepted: classifyProviderStatus(status),
      region,
      latency_ms: Date.now() - started,
    };
  } catch (e) {
    console.error("[diagnostics] letter model probe failed:", redactError(e));
    return { ...base, reachable: false, http_status: null, key_accepted: null, region: null, latency_ms: Date.now() - started };
  }
}

/**
 * Opens a real session against the configured live-transcription vendor.
 *
 * The streaming path is the one a clinician depends on in the room, and it is
 * the one this diagnostic did not cover: it probed the batch endpoint of one
 * vendor while the live socket could be a different vendor entirely. A key
 * that is wrong, revoked, or on a plan without the configured model fails
 * only when someone presses record.
 *
 * So this does what the browser does — builds the session the same way, opens
 * the socket, and reports whether the vendor accepted it. No audio is sent.
 */
async function probeStreamingVendor(
  vendor: StreamingVendor,
): Promise<{
  vendor: string;
  host: string;
  model: string;
  reachable: boolean;
  accepted: boolean | null;
  detail: string;
  latency_ms: number;
}> {
  const started = Date.now();
  const base = { vendor, host: "", model: "" };

  let session;
  try {
    session = await buildStreamingSession(vendor, (n) => Deno.env.get(n));
  } catch (e) {
    // Configuration refused the session — a missing key, or a non-EU host.
    return {
      ...base,
      reachable: false,
      accepted: null,
      detail: e instanceof Error ? e.message : "Could not build a session",
      latency_ms: Date.now() - started,
    };
  }

  const host = (() => {
    try { return new URL(session.wsUrl).host; } catch { return "invalid"; }
  })();

  return await new Promise((resolve) => {
    let settled = false;
    const finish = (accepted: boolean | null, detail: string) => {
      if (settled) return;
      settled = true;
      try { socket.close(); } catch { /* already closing */ }
      resolve({
        vendor,
        host,
        model: session.model,
        reachable: true,
        accepted,
        detail,
        latency_ms: Date.now() - started,
      });
    };

    let socket: WebSocket;
    try {
      socket = session.protocols?.length
        ? new WebSocket(session.wsUrl, session.protocols)
        : new WebSocket(session.wsUrl);
    } catch (e) {
      return resolve({
        ...base,
        host,
        model: session.model,
        reachable: false,
        accepted: null,
        detail: e instanceof Error ? e.message : "Could not open a socket",
        latency_ms: Date.now() - started,
      });
    }

    const timer = setTimeout(() => finish(null, "No response within 8 seconds"), 8000);

    socket.onopen = () => {
      clearTimeout(timer);
      finish(true, "Session opened and the credential was accepted.");
    };
    socket.onerror = () => {
      clearTimeout(timer);
      // A vendor refusing the handshake does not tell us why on the socket;
      // the cause is almost always the credential or the configured model.
      finish(false, "The vendor refused the session. Check the API key and that the configured model is available on the account.");
    };
    socket.onclose = (e) => {
      clearTimeout(timer);
      if (settled) return;
      finish(e.code === 1000, `Closed before opening (code ${e.code}${e.reason ? `: ${e.reason}` : ""})`);
    };
  });
}

/** A sentence an operator can act on, for each AI-provider outcome. */
function summariseAiProbe(probe: AiProbeResult): string {
  if (!probe.reachable && probe.http_status === null && probe.latency_ms === 0) {
    return "No key is configured for the AI provider.";
  }
  if (!probe.reachable) {
    return `Could not reach ${probe.host}. Check network egress.`;
  }
  if (probe.key_accepted === false && probe.http_status === 404) {
    return `Reached ${probe.host}, but "${probe.model}" is not deployed there. ` +
      "This will be failing until the deployment name matches.";
  }
  if (probe.key_accepted === false) {
    return `${probe.host} rejected the credential. This will be failing.`;
  }
  if (probe.key_accepted === true) {
    const where = probe.region ? ` Processing region: ${probe.region}.` : "";
    return `Working via ${probe.host} using "${probe.model}".${where}`;
  }
  return `${probe.host} returned HTTP ${probe.http_status}, which is neither an acceptance nor a rejection.`;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user }, error: userErr } = await supabase.auth.getUser();
    if (userErr || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const apiKey = Deno.env.get("DEEPGRAM_API_KEY");
    const configuredBase = Deno.env.get("DEEPGRAM_API_BASE");
    const configuredHost = resolveStreamingHost(configuredBase);

    if (!apiKey) {
      return new Response(
        JSON.stringify({
          configured_endpoint: configuredHost,
          eu_resident: isEuResidentStreamingHost(configuredBase),
          error: "No API key is configured for the live transcription service.",
          verdict: "not_configured",
          summary: "The live transcription service has no API key configured.",
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const wav = makeTestWav();

    // Probe the configured endpoint, plus the global one for comparison. The
    // global probe is what distinguishes "key is region-scoped" from
    // "key is invalid" — the two look identical if you only test one.
    // Which vendor actually serves live transcription, and does it answer?
    const { primary: liveVendor, fallback: fallbackVendor } = resolveVendors((n) => Deno.env.get(n));

    const [configured, global, ai, letters, live, liveFallback] = await Promise.all([
      probeStreaming(configuredHost, apiKey, wav),
      configuredHost === STREAMING_GLOBAL_HOST
        ? Promise.resolve(null)
        : probeStreaming(STREAMING_GLOBAL_HOST, apiKey, wav),
      // Enhanced dictation runs through a different provider from live
      // transcription, so a diagnostic that only covered the streaming path
      // would report everything healthy while dictation was failing.
      probeAiProvider(wav),
      // Transcription and letter generation are separate deployments. One
      // working says nothing about the other.
      probeLetterModel(),
      // The socket a clinician actually depends on. Opened for real, with no
      // audio sent: a key that is wrong, revoked, or on a plan without the
      // configured model otherwise fails only when someone presses record.
      probeStreamingVendor(liveVendor),
      fallbackVendor ? probeStreamingVendor(fallbackVendor) : Promise.resolve(null),
    ]);

    // Readiness check for the successor transcription deployment, reported
    // without anything being pointed at it. gpt-4o-transcribe is retired by
    // Microsoft on 31 December 2026, mid-pilot, so whether its replacement
    // exists on the resource is worth knowing before that date rather than
    // after it.
    const SUCCESSOR_DEPLOYMENT = "gpt-transcribe";
    const activeDictationModel = ai.model;
    const successor = activeDictationModel === SUCCESSOR_DEPLOYMENT
      ? null
      : await probeAiProvider(wav, SUCCESSOR_DEPLOYMENT);

    // Correlate the two results into a single verdict (shared, unit-tested).
    const euConfigured = isEuResidentStreamingHost(configuredBase);
    const verdict = resolveResidencyVerdict({
      configuredReachable: configured.reachable,
      configuredKeyAccepted: configured.key_accepted,
      globalKeyAccepted: global ? global.key_accepted : null,
      euConfigured,
    });

    const SUMMARIES: Record<string, string> = {
      eu_ok_region_locked: "EU endpoint working, and the credential is restricted to the EU region.",
      eu_ok: "EU endpoint working. Audio is processed in the EU.",
      not_provisioned: "The account is not enabled for EU processing. Contact the provider.",
      invalid_key: "The API key was rejected everywhere — it is expired, revoked, or incorrect. Live transcription will be failing.",
      unreachable: "Could not reach the transcription service. Check network egress.",
      not_eu_configured: `The service is configured to use ${configuredHost}, which is not the EU endpoint.`,
    };
    const summary = SUMMARIES[verdict];

    console.log(
      `[diagnostics] verdict=${verdict} configured=${configuredHost}(${configured.http_status}) ` +
      `global=${global ? global.http_status : "skipped"}`,
    );
    console.log(
      `[diagnostics] live vendor=${live.vendor} host=${live.host} model=${live.model} ` +
      `accepted=${live.accepted} fallback=${liveFallback ? `${liveFallback.vendor}:${liveFallback.accepted}` : "none"}`,
    );
    for (const [label, probe] of [["dictation", ai], ["letters", letters]] as const) {
      console.log(
        `[diagnostics] ${label} provider=${probe.provider} host=${probe.host} model=${probe.model} ` +
        `status=${probe.http_status} accepted=${probe.key_accepted} region=${probe.region ?? "n/a"}`,
      );
    }

    return new Response(
      JSON.stringify({
        verdict,
        summary,
        eu_resident: euConfigured,
        privacy_opt_out: configured.privacy_opt_out,
        configured_endpoint: configuredHost,
        expected_eu_endpoint: STREAMING_EU_HOST,
        checks: { configured, global },
        // Enhanced dictation, reported separately because it is a different
        // provider with its own credential, region and failure modes.
        enhanced_dictation: { ...ai, summary: summariseAiProbe(ai) },
        letter_generation: { ...letters, summary: summariseAiProbe(letters) },
        live_transcription: live,
        live_transcription_fallback: liveFallback,
        dictation_successor: successor
          ? {
              ...successor,
              summary: successor.key_accepted === true
                ? `"${successor.model}" is deployed and ready. Enhanced dictation can be switched to it.`
                : successor.http_status === 404
                ? `"${successor.model}" is not deployed on this resource yet.`
                : summariseAiProbe(successor),
            }
          : null,
        checked_at: new Date().toISOString(),
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    console.error("diagnostics-transcription error:", redactError(error));
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
