import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  streamingHttpUrl,
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

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

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
};

async function probeStreaming(host: string, apiKey: string, wav: Uint8Array): Promise<ProbeResult> {
  const endpoint = `https://${host}/v1/listen?model=nova-2-medical&language=en-GB`;
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
    };
  } catch (e) {
    console.error(`[diagnostics] probe failed for ${host}:`, e);
    return {
      endpoint: host,
      reachable: false,
      http_status: null,
      key_accepted: null,
      region: null,
      latency_ms: Date.now() - started,
    };
  }
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
    const [configured, global] = await Promise.all([
      probeStreaming(configuredHost, apiKey, wav),
      configuredHost === STREAMING_GLOBAL_HOST
        ? Promise.resolve(null)
        : probeStreaming(STREAMING_GLOBAL_HOST, apiKey, wav),
    ]);

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

    return new Response(
      JSON.stringify({
        verdict,
        summary,
        eu_resident: euConfigured,
        configured_endpoint: configuredHost,
        expected_eu_endpoint: STREAMING_EU_HOST,
        checks: { configured, global },
        checked_at: new Date().toISOString(),
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    console.error("diagnostics-transcription error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
