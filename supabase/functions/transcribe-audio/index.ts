import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// GCP identity token (for private Cloud Run service auth)
async function getGcpIdentityToken(serviceAccountKey: string, targetAudience: string): Promise<string> {
  const sa = JSON.parse(serviceAccountKey);
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: sa.client_email,
    sub: sa.client_email,
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
    target_audience: targetAudience,
  };
  const encode = (obj: unknown) =>
    btoa(JSON.stringify(obj)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const unsignedToken = `${encode(header)}.${encode(claims)}`;
  const pemContent = sa.private_key
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\n/g, "");
  const binaryKey = Uint8Array.from(atob(pemContent), (c) => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    binaryKey,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(unsignedToken)
  );
  const sig = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const jwt = `${unsignedToken}.${sig}`;
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  if (!tokenResponse.ok) {
    throw new Error(`GCP token exchange failed: ${await tokenResponse.text()}`);
  }
  const { id_token } = await tokenResponse.json();
  return id_token;
}

const CONTENT_TYPE_MAP: Record<string, string> = {
  webm: "audio/webm",
  wav: "audio/wav",
  mp3: "audio/mpeg",
  mpeg: "audio/mpeg",
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  ogg: "audio/ogg",
};

async function transcribeMedical(audioBlob: Blob, audioPath: string): Promise<string> {
  const MEDASR_URL = Deno.env.get("MEDASR_URL");
  const GCP_SERVICE_ACCOUNT_KEY = Deno.env.get("GCP_SERVICE_ACCOUNT_KEY");
  const MEDASR_API_KEY = Deno.env.get("MEDASR_API_KEY");
  if (!MEDASR_URL) throw new Error("Medical transcription service is not configured");

  const headers: Record<string, string> = {};
  if (GCP_SERVICE_ACCOUNT_KEY) {
    const idToken = await getGcpIdentityToken(GCP_SERVICE_ACCOUNT_KEY, MEDASR_URL);
    headers["Authorization"] = `Bearer ${idToken}`;
  } else if (MEDASR_API_KEY) {
    headers["Authorization"] = `Bearer ${MEDASR_API_KEY}`;
  }

  const formData = new FormData();
  formData.append("file", audioBlob, `audio.${audioPath.split(".").pop() || "webm"}`);

  const resp = await fetch(`${MEDASR_URL}/transcribe`, {
    method: "POST",
    headers,
    body: formData,
  });
  if (!resp.ok) {
    const body = await resp.text();
    console.error("[transcribe-audio] Medical HTTP", resp.status, body.slice(0, 500));
    throw new Error(`Transcription failed (HTTP ${resp.status})`);
  }
  const result = await resp.json();
  const text = (result.text || "").trim();
  if (!text) throw new Error("No speech detected");
  return text;
}

async function transcribeStreaming(audioBlob: Blob, audioPath: string): Promise<string> {
  const DEEPGRAM_API_KEY = Deno.env.get("DEEPGRAM_API_KEY");
  if (!DEEPGRAM_API_KEY) throw new Error("Streaming transcription service is not configured");

  const ext = (audioPath.split(".").pop() || "webm").toLowerCase();
  const contentType = CONTENT_TYPE_MAP[ext] || "audio/webm";
  const arrayBuffer = await audioBlob.arrayBuffer();

  const params = new URLSearchParams({
    model: "nova-2-medical",
    language: "en-GB",
    smart_format: "true",
    punctuate: "true",
    paragraphs: "true",
  });
  const resp = await fetch(`https://api.deepgram.com/v1/listen?${params}`, {
    method: "POST",
    headers: {
      Authorization: `Token ${DEEPGRAM_API_KEY}`,
      "Content-Type": contentType,
    },
    body: arrayBuffer,
  });
  if (!resp.ok) {
    const body = await resp.text();
    console.error("[transcribe-audio] Streaming HTTP", resp.status, body.slice(0, 500));
    throw new Error(`Transcription failed (HTTP ${resp.status})`);
  }
  const result = await resp.json();
  const text = (result?.results?.channels?.[0]?.alternatives?.[0]?.transcript || "").trim();
  if (!text) throw new Error("No speech detected");
  return text;
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
      { global: { headers: { Authorization: authHeader } } }
    );
    const { data: { user }, error: userErr } = await supabase.auth.getUser();
    if (userErr || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { audio_path, engine } = await req.json();
    if (!audio_path) throw new Error("audio_path is required");
    const useMedical = engine === "accurate" || engine === "medical";

    // Download audio (RLS-scoped to the caller)
    const { data: audioData, error: downloadErr } = await supabase.storage
      .from("audio-recordings")
      .download(audio_path);
    if (downloadErr) throw new Error(`Failed to download audio: ${downloadErr.message}`);

    const transcript = useMedical
      ? await transcribeMedical(audioData, audio_path)
      : await transcribeStreaming(audioData, audio_path);

    return new Response(
      JSON.stringify({ transcript, engine: useMedical ? "accurate" : "fast" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("transcribe-audio error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
