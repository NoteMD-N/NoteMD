import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { redactError } from "../_shared/redact.ts";
import { checkRateLimit, rateLimitedResponse } from "../_shared/rate-limit.ts";
import {
  assemblyAiWsUrl,
  audioFormatFor,
  deepgramWsUrl,
  hasRequiredPrivacyControls,
  isEuHost,
  modelFor,
  PCM_SAMPLE_RATE,
  resolveHost,
  resolveVendors,
  type StreamingSession,
  type StreamingVendor,
} from "../_shared/streaming-providers.ts";

/**
 * Issues a session for live transcription.
 *
 * Replaces `deepgram-token`, which returned the long-lived Deepgram API key to
 * the browser — any signed-in user could read it from the network tab and use
 * it outside the application entirely.
 *
 * This hands out a short-lived credential instead, and builds the complete
 * endpoint URL server-side so the browser cannot omit a privacy control or
 * reach a region outside the EEA.
 *
 * The response names a vendor and, when one is configured, a fallback the
 * client may use if the primary will not open. Both descriptors are built
 * here, so choosing the fallback is not a decision the browser makes about
 * where audio may go.
 */

const env = (name: string) => Deno.env.get(name);

/**
 * AssemblyAI's temporary token.
 *
 * Minted per session with a short redemption window: it must be used to open
 * the socket within this many seconds, after which it is refused. It does not
 * cap the session's own length.
 */
async function mintAssemblyAiToken(apiKey: string): Promise<string> {
  const url = new URL("https://streaming.assemblyai.com/v3/token");
  url.searchParams.set("expires_in_seconds", "120");

  const resp = await fetch(url, {
    headers: { Authorization: apiKey },
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) {
    // The body can echo the key back in an error; it never reaches the client.
    console.error(`[streaming-session] AssemblyAI token request failed: HTTP ${resp.status}`);
    throw new Error("Transcription service is unavailable");
  }
  const body = await resp.json();
  const token = body?.token;
  if (typeof token !== "string" || !token) {
    throw new Error("Transcription service is unavailable");
  }
  return token;
}

/** Builds a complete, privacy-checked session descriptor for one vendor. */
async function buildSession(vendor: StreamingVendor): Promise<StreamingSession> {
  const configuredHost = vendor === "deepgram"
    ? env("DEEPGRAM_API_BASE")
    : env("ASSEMBLYAI_API_BASE");
  const host = resolveHost(vendor, configuredHost);

  if (!isEuHost(vendor, host)) {
    // Loud, because this means patient audio would leave EU infrastructure.
    // For AssemblyAI the default host is the one that edge-routes to the US,
    // so this is not a hypothetical misconfiguration.
    console.error(
      `[streaming-session] NON-EU host configured for ${vendor}: ${host}. Refusing to issue a session.`,
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
  // through. The cost of being wrong here is patient audio retained or
  // trained on, which cannot be undone once it has happened.
  if (!hasRequiredPrivacyControls(vendor, session.wsUrl)) {
    console.error(`[streaming-session] refusing to issue a ${vendor} URL missing privacy controls`);
    throw new Error("Transcription service is misconfigured");
  }

  return session;
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

    const { data: { user }, error } = await supabase.auth.getUser();
    if (error || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Rate limit after authentication, before anything that costs money or
    // reaches a vendor.
    const rl = await checkRateLimit(supabase, "deepgram-token");
    if (!rl.allowed) {
      return rateLimitedResponse("deepgram-token", rl, corsHeaders);
    }

    const { primary, fallback } = resolveVendors(env);
    const session = await buildSession(primary);

    // The fallback is built now rather than on failure: the browser must not
    // wait for a second round trip at the moment the primary has just refused
    // to open, mid-consultation. A fallback that cannot be built is simply
    // absent — it must never take down the primary path.
    let fallbackSession: StreamingSession | null = null;
    if (fallback) {
      try {
        fallbackSession = await buildSession(fallback);
      } catch (e) {
        console.warn(`[streaming-session] fallback ${fallback} unavailable:`, redactError(e));
      }
    }

    console.log(
      `[streaming-session] vendor=${session.vendor} model=${session.model} ` +
      `format=${session.audioFormat} fallback=${fallbackSession?.vendor ?? "none"}`,
    );

    return new Response(
      JSON.stringify({ session, fallback: fallbackSession }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    console.error("streaming-session error:", redactError(error));
    // Detail stays in the server log: internal errors name the vendor and its
    // configuration, neither of which belongs in the browser.
    return new Response(
      JSON.stringify({ error: "Could not start the transcription service" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
