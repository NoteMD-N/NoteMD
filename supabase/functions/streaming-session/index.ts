import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { redactError } from "../_shared/redact.ts";
import { checkRateLimit, rateLimitedResponse } from "../_shared/rate-limit.ts";
import {
  buildStreamingSession,
  resolveVendors,
  type StreamingSession,
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

    // Two different failures, both of which the fallback must cover.
    //
    // The socket may refuse to open, which the browser handles with the
    // fallback descriptor below. But the session may also fail to *build* —
    // the token endpoint down, the key revoked — and that happens here. The
    // first version of this threw, returned 500, and never reached a
    // configured, healthy fallback: exactly the outage the fallback exists to
    // prevent.
    let session: StreamingSession;
    let demoted: string | null = null;
    try {
      session = await buildStreamingSession(primary, env);
    } catch (primaryError) {
      if (!fallback) throw primaryError;
      console.error(
        `[streaming-session] could not build a ${primary} session; using ${fallback}:`,
        redactError(primaryError),
      );
      session = await buildStreamingSession(fallback, env);
      demoted = primary;
    }

    // The standby is built now rather than on failure: the browser must not
    // wait for a second round trip at the moment the primary has just refused
    // to open, with a clinician waiting to start. A standby that cannot be
    // built is simply absent — it must never take down the working path.
    let fallbackSession: StreamingSession | null = null;
    const standby = fallback && fallback !== session.vendor ? fallback : null;
    if (standby) {
      try {
        fallbackSession = await buildStreamingSession(standby, env);
      } catch (e) {
        console.warn(`[streaming-session] standby ${standby} unavailable:`, redactError(e));
      }
    }

    console.log(
      `[streaming-session] vendor=${session.vendor} model=${session.model} ` +
      `format=${session.audioFormat} fallback=${fallbackSession?.vendor ?? "none"}` +
      (demoted ? ` (${demoted} unavailable)` : ""),
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
