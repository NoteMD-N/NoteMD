import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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
    const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
    if (!OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY is not configured");
    }

    const MEDASR_URL = Deno.env.get("MEDASR_URL");
    const MEDASR_API_KEY = Deno.env.get("MEDASR_API_KEY");
    const GCP_SERVICE_ACCOUNT_KEY = Deno.env.get("GCP_SERVICE_ACCOUNT_KEY");
    if (!MEDASR_URL) {
      throw new Error("MEDASR_URL must be configured");
    }

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

    const { data: claimsData, error: claimsError } = await supabase.auth.getClaims(
      authHeader.replace("Bearer ", "")
    );
    if (claimsError || !claimsData?.claims) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const userId = claimsData.claims.sub;
    const { recording_id, audio_path } = await req.json();

    if (!recording_id || !audio_path) {
      throw new Error("recording_id and audio_path are required");
    }

    // Download audio from storage
    const { data: audioData, error: downloadError } = await supabase.storage
      .from("audio-recordings")
      .download(audio_path);
    if (downloadError) throw new Error(`Failed to download audio: ${downloadError.message}`);

    // Update status to processing
    await supabase
      .from("recordings")
      .update({ status: "processing" })
      .eq("id", recording_id);

    // Step 1: Transcribe with Google MedASR via Cloud Run service
    const formData = new FormData();
    formData.append("file", audioData, "audio.webm");

    // Build auth headers for Cloud Run
    const medAsrHeaders: Record<string, string> = {};
    if (GCP_SERVICE_ACCOUNT_KEY) {
      // Use GCP identity token for Cloud Run IAM auth
      const idToken = await getGcpIdentityToken(GCP_SERVICE_ACCOUNT_KEY, MEDASR_URL);
      medAsrHeaders["Authorization"] = `Bearer ${idToken}`;
    } else if (MEDASR_API_KEY) {
      medAsrHeaders["Authorization"] = `Bearer ${MEDASR_API_KEY}`;
    }

    const medAsrResponse = await fetch(`${MEDASR_URL}/transcribe`, {
      method: "POST",
      headers: medAsrHeaders,
      body: formData,
    });

    if (!medAsrResponse.ok) {
      const errText = await medAsrResponse.text();
      console.error("MedASR error:", errText);
      await supabase.from("recordings").update({ status: "error" }).eq("id", recording_id);
      throw new Error(`Transcription failed: ${errText}`);
    }

    const medAsrResult = await medAsrResponse.json();
    const transcript = medAsrResult.text;

    // Update recording status
    await supabase
      .from("recordings")
      .update({ status: "transcribed" })
      .eq("id", recording_id);

    // Step 2: Generate clinical letter with GPT
    const gptResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [
          {
            role: "system",
            content: `You are a professional UK clinical documentation assistant. Convert consultation transcripts into professional clinical letters addressed to the referring GP.

The letter MUST include the following sections:
- Date and addressing (Dear Dr [GP Name])
- Re: Patient details
- History of Presenting Complaint
- Examination Findings
- Impression / Diagnosis
- Management Plan
- Follow-up arrangements
- Yours sincerely, [Clinician Name]

Use formal UK medical letter conventions. Be concise and professional. If information is unclear from the transcript, note it appropriately. Do not fabricate clinical details.`,
          },
          {
            role: "user",
            content: `Please convert the following consultation transcript into a professional UK clinical letter:\n\n${transcript}`,
          },
        ],
        temperature: 0.3,
        max_tokens: 2000,
      }),
    });

    if (!gptResponse.ok) {
      const errText = await gptResponse.text();
      console.error("GPT error:", errText);
      await supabase.from("recordings").update({ status: "error" }).eq("id", recording_id);
      throw new Error(`Letter generation failed: ${errText}`);
    }

    const gptData = await gptResponse.json();
    const letterContent = gptData.choices[0].message.content;

    // Save letter
    const { data: letter, error: letterError } = await supabase
      .from("letters")
      .insert({
        recording_id,
        user_id: userId,
        transcript,
        letter_content: letterContent,
        status: "draft",
      })
      .select()
      .single();

    if (letterError) throw letterError;

    // Update recording status
    await supabase
      .from("recordings")
      .update({ status: "letter_generated" })
      .eq("id", recording_id);

    return new Response(
      JSON.stringify({ letter_id: letter.id, success: true }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("generate-letter error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
