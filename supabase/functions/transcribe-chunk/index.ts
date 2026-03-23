import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// Generate a GCP identity token for Cloud Run authentication
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
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  const jwt = `${unsignedToken}.${sig}`;

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });

  if (!tokenResponse.ok) {
    const err = await tokenResponse.text();
    throw new Error(`Failed to get GCP identity token: ${err}`);
  }

  const { id_token } = await tokenResponse.json();
  return id_token;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const t0 = Date.now();
    console.log("[transcribe-chunk] START");

    const MEDASR_URL = Deno.env.get("MEDASR_URL");
    const GCP_SERVICE_ACCOUNT_KEY = Deno.env.get("GCP_SERVICE_ACCOUNT_KEY");
    const MEDASR_API_KEY = Deno.env.get("MEDASR_API_KEY");

    console.log("[transcribe-chunk] MEDASR_URL:", MEDASR_URL ? "SET" : "NOT SET");
    console.log("[transcribe-chunk] GCP_SA_KEY:", GCP_SERVICE_ACCOUNT_KEY ? "SET" : "NOT SET");
    console.log("[transcribe-chunk] MEDASR_API_KEY:", MEDASR_API_KEY ? "SET" : "NOT SET");

    if (!MEDASR_URL) {
      throw new Error("MEDASR_URL must be configured");
    }

    // Parse audio from FormData (no auth needed — deployed with --no-verify-jwt)
    const formData = await req.formData();
    const audioFile = formData.get("audio") as File;
    if (!audioFile) {
      throw new Error("audio file is required");
    }

    console.log(`[transcribe-chunk] Audio chunk: ${audioFile.size} bytes (${Date.now() - t0}ms)`);

    // Build auth headers for Cloud Run
    const medAsrHeaders: Record<string, string> = {};
    if (GCP_SERVICE_ACCOUNT_KEY) {
      const idToken = await getGcpIdentityToken(GCP_SERVICE_ACCOUNT_KEY, MEDASR_URL);
      medAsrHeaders["Authorization"] = `Bearer ${idToken}`;
      console.log(`[transcribe-chunk] GCP token obtained (${Date.now() - t0}ms)`);
    } else if (MEDASR_API_KEY) {
      medAsrHeaders["Authorization"] = `Bearer ${MEDASR_API_KEY}`;
    } else {
      console.warn("[transcribe-chunk] WARNING: No MedASR auth configured");
    }

    // Forward to MedASR
    const medAsrFormData = new FormData();
    medAsrFormData.append("file", audioFile, "chunk.wav");

    console.log(`[transcribe-chunk] Calling MedASR... (${Date.now() - t0}ms)`);
    const medAsrResponse = await fetch(`${MEDASR_URL}/transcribe`, {
      method: "POST",
      headers: medAsrHeaders,
      body: medAsrFormData,
    });

    console.log(`[transcribe-chunk] MedASR responded: ${medAsrResponse.status} (${Date.now() - t0}ms)`);

    if (!medAsrResponse.ok) {
      const errText = await medAsrResponse.text();
      console.error("[transcribe-chunk] MedASR error:", errText);
      throw new Error(`Transcription failed (${medAsrResponse.status}): ${errText}`);
    }

    const result = await medAsrResponse.json();
    console.log(`[transcribe-chunk] DONE: "${(result.text || "").slice(0, 80)}..." (${Date.now() - t0}ms)`);

    return new Response(
      JSON.stringify({ text: result.text }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("transcribe-chunk error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
