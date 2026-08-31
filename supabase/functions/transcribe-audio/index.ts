import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { resolveProvider, providerTier, buildBatchUrl } from "../_shared/transcription-policy.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { redactVendorError } from "../_shared/redact.ts";

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

// ---------------------------------------------------------------------------
// OpenAI endpoint base.
//
// Data residency: OpenAI serves EU-resident projects from a regional hostname.
// Keeping the base URL in an env var means switching NoteMD onto an EU-resident
// OpenAI project is a configuration change, not a redeploy of application code.
// Defaults to the global endpoint so behaviour is unchanged until it is set.
//
//   OPENAI_API_BASE=https://eu.api.openai.com/v1
// ---------------------------------------------------------------------------
function openAiUrl(path: string): string {
  const base = (Deno.env.get("OPENAI_API_BASE") || "https://api.openai.com/v1").replace(/\/+$/, "");
  return `${base}/${path.replace(/^\/+/, "")}`;
}

// ---------------------------------------------------------------------------
// OpenAI transcription (primary "accurate" engine).
//
// Chosen over MedASR at the client's request after their own A/B testing.
// Notes that matter for correctness:
//  - The API caps uploads at 25MB. A 10s webm/opus segment is ~20-40KB and a
//    30-minute consultation is ~15MB, so we're normally well inside it, but we
//    check and fail with a clear message rather than a raw 413.
//  - `prompt` biases decoding toward clinical vocabulary and UK spelling. It is
//    a hint, NOT instructions — the model may ignore it, and it must never be
//    used to inject content into the transcript.
//  - `language: "en"` stops short segments being misdetected as another language.
// ---------------------------------------------------------------------------
const OPENAI_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

const CLINICAL_PROMPT =
  "UK clinical dictation. British English spelling (anaemia, oedema, paediatric, " +
  "haematology, diarrhoea, orthopaedic). Common terms: NHS, GP, mg, mcg, BD, TDS, QDS, PRN, " +
  "PO, IV, IM, SC, ECG, MRI, CT, FBC, U&Es, LFTs, CRP, HbA1c, BP, BMI, PMH, ICE, " +
  "sumatriptan, amlodipine, atorvastatin, levothyroxine, salbutamol, omeprazole.";

async function transcribeOpenAI(audioBlob: Blob, audioPath: string): Promise<string> {
  const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
  if (!OPENAI_API_KEY) throw new Error("Transcription service is not configured (OPENAI_API_KEY)");

  if (audioBlob.size > OPENAI_MAX_UPLOAD_BYTES) {
    throw new Error(
      `Recording is too large to transcribe in one request (${Math.round(audioBlob.size / 1024 / 1024)}MB, limit 25MB).`
    );
  }
  if (audioBlob.size === 0) throw new Error("Audio file is empty");

  // gpt-4o-transcribe is the current highest-accuracy model; whisper-1 remains
  // available as an override via env if we ever need to pin back.
  const model = Deno.env.get("OPENAI_TRANSCRIBE_MODEL") || "gpt-4o-transcribe";

  const ext = (audioPath.split(".").pop() || "webm").toLowerCase();
  const form = new FormData();
  form.append("file", audioBlob, `audio.${ext}`);
  form.append("model", model);
  form.append("language", "en");
  form.append("prompt", CLINICAL_PROMPT);
  form.append("response_format", "text");
  // temperature 0 = deterministic; avoids the model "smoothing" clinical detail.
  form.append("temperature", "0");

  const resp = await fetch(openAiUrl("audio/transcriptions"), {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: form,
  });

  if (!resp.ok) {
    const body = await resp.text();
    console.error("[transcribe-openai] HTTP", resp.status, redactVendorError(body));
    // Surface a useful message rather than a bare status code.
    let detail = "";
    try { detail = JSON.parse(body)?.error?.message || ""; } catch { /* plain text body */ }
    throw new Error(`Transcription failed (HTTP ${resp.status})${detail ? `: ${detail}` : ""}`);
  }

  // response_format=text returns a bare string body, not JSON.
  const text = (await resp.text()).trim();
  if (!text) throw new Error("No speech detected");
  return text;
}

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
    console.error("[transcribe-audio] Medical HTTP", resp.status, redactVendorError(body));
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

  // URL built centrally so the privacy opt-out is always present.
  const resp = await fetch(buildBatchUrl(Deno.env.get("DEEPGRAM_API_BASE")), {
    method: "POST",
    headers: {
      Authorization: `Token ${DEEPGRAM_API_KEY}`,
      "Content-Type": contentType,
    },
    body: arrayBuffer,
  });
  if (!resp.ok) {
    const body = await resp.text();
    console.error("[transcribe-audio] Streaming HTTP", resp.status, redactVendorError(body));
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

    // Engine routing lives in _shared/transcription-policy.ts so it is unit
    // tested against the same code that runs here.
    const provider = resolveProvider(engine, Deno.env.get("TRANSCRIBE_ACCURATE_PROVIDER"));
    const useOpenAI = provider === "openai";
    const useMedical = provider === "medasr";

    // Download audio (RLS-scoped to the caller)
    const { data: audioData, error: downloadErr } = await supabase.storage
      .from("audio-recordings")
      .download(audio_path);
    if (downloadErr) throw new Error(`Failed to download audio: ${downloadErr.message}`);

    const transcript = useOpenAI
      ? await transcribeOpenAI(audioData, audio_path)
      : useMedical
      ? await transcribeMedical(audioData, audio_path)
      : await transcribeStreaming(audioData, audio_path);

    // The specific vendor is deliberately NOT returned to the client — the
    // transcription engine is proprietary and should not be discoverable from
    // the browser. It is logged server-side so support can still diagnose
    // which path ran.
    console.log(`[transcribe-audio] provider=${provider} chars=${transcript.length}`);

    return new Response(
      JSON.stringify({
        transcript,
        engine: providerTier(provider),
      }),
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
