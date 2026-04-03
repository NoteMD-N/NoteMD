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
    const { recording_id, audio_path, transcript: preBuiltTranscript, mode } = await req.json();

    if (!recording_id) {
      throw new Error("recording_id is required");
    }

    let transcript: string;

    if (preBuiltTranscript) {
      // Transcript was already built from chunked real-time transcription
      transcript = preBuiltTranscript;

      // Update status
      await supabase
        .from("recordings")
        .update({ status: "transcribed" })
        .eq("id", recording_id);
    } else {
      // Legacy path: download audio and transcribe in one go
      if (!audio_path) {
        throw new Error("audio_path is required when transcript is not provided");
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

      // Transcribe with Google MedASR via Cloud Run service
      const formData = new FormData();
      formData.append("file", audioData, "audio.webm");

      // Build auth headers for Cloud Run
      const medAsrHeaders: Record<string, string> = {};
      if (GCP_SERVICE_ACCOUNT_KEY) {
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
      transcript = medAsrResult.text;

      // Update recording status
      await supabase
        .from("recordings")
        .update({ status: "transcribed" })
        .eq("id", recording_id);
    }

    // Step 2: Generate clinical letter
    // Check if user has a custom template
    const { data: profileData } = await supabase
      .from("profiles")
      .select("letter_template")
      .eq("user_id", userId)
      .single();

    const defaultConsultationPrompt = `You are a professional UK clinical documentation assistant. Convert consultation transcripts into clinical letters using the exact template format below. Do not deviate from this structure.

TEMPLATE FORMAT:

Diagnosis: [Insert diagnosis based on the transcript]

Plan:
• [Bullet point 1]
• [Bullet point 2]
• [Continue as needed]

________________________________________

Dear Dr [GP Name],

Thank you for referring this patient...

[Write all the details of the history in this section as continuous narrative text. No bullet points. Include presenting complaint, relevant history, examination findings, and all clinical details discussed in the consultation.]

[Insert clinical impression]: [Write the plan as a narrative here, incorporating what was discussed, agreed upon, and any follow-up arrangements. Write all the details of the discussion regarding management.]

Dr [Doctor Name]

RULES:
- The top section (Diagnosis + Plan bullets) is a quick-reference summary
- The letter body after the line must be flowing narrative text, no bullet points
- Extract the GP name and doctor name from the transcript if mentioned, otherwise use placeholders
- Do not fabricate clinical details. If information is unclear, note it appropriately
- Use formal UK medical letter conventions
- Be thorough and detailed — include ALL clinical information from the transcript
- The letter should be comprehensive enough that the GP has a complete picture of the consultation`;

    const defaultDictationPrompt = `You are a professional UK clinical documentation assistant. The following is a dictated clinical note. Clean it up into a well-structured, professional clinical document while preserving all clinical details exactly as dictated.

RULES:
- Correct grammar, punctuation, and formatting but do NOT change clinical meaning
- Structure the output with clear headings where appropriate (e.g. Presenting Complaint, History, Examination, Impression, Plan)
- Remove filler words, false starts, and repetitions
- Use formal UK medical conventions
- Do not fabricate or infer any clinical details not present in the dictation
- Preserve all medical terminology exactly as dictated`;

    const systemPrompt = profileData?.letter_template
      ? profileData.letter_template
      : mode === "dictation"
      ? defaultDictationPrompt
      : defaultConsultationPrompt;

    const userPrompt = mode === "dictation"
      ? `Please clean up the following dictated clinical note:\n\n${transcript}`
      : `Please convert the following consultation transcript into a clinical letter using the template format:\n\n${transcript}`;

    const gptResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.3,
        max_tokens: 4000,
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
