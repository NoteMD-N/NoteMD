import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { streamingWsUrl, isEuResidentStreamingHost } from "../_shared/transcription-policy.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

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

    // Verify the user is authenticated
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user }, error } = await supabase.auth.getUser();
    if (error || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const DEEPGRAM_API_KEY = Deno.env.get("DEEPGRAM_API_KEY");
    if (!DEEPGRAM_API_KEY) {
      throw new Error("DEEPGRAM_API_KEY is not configured");
    }

    // Return the endpoint alongside the key so the browser never hardcodes a
    // region. Changing DEEPGRAM_API_BASE repoints real-time transcription
    // without a frontend rebuild, and keeps one source of truth for residency.
    const configuredBase = Deno.env.get("DEEPGRAM_API_BASE");
    const wsUrl = streamingWsUrl(configuredBase);

    if (!isEuResidentStreamingHost(configuredBase)) {
      // Loud, because this means patient audio is leaving EU infrastructure.
      console.warn(
        "[deepgram-token] NON-EU streaming endpoint in use:",
        wsUrl,
        "- set DEEPGRAM_API_BASE=https://api.eu.deepgram.com for EU residency",
      );
    }

    return new Response(
      JSON.stringify({ key: DEEPGRAM_API_KEY, ws_url: wsUrl }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("deepgram-token error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
