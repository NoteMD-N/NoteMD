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
    const {
      recording_id,
      audio_path,
      transcript: preBuiltTranscript,
      mode,
      patient_name,
      patient_id,
      template_id,
    } = await req.json();

    if (!recording_id) {
      throw new Error("recording_id is required");
    }

    let transcript: string;

    // For dictation mode, always use MedASR for highest accuracy (re-transcribe even if Deepgram transcript exists)
    const shouldUseMedAsr = mode === "dictation" || !preBuiltTranscript;

    if (preBuiltTranscript && !shouldUseMedAsr) {
      // Consultation mode: use Deepgram transcript directly
      transcript = preBuiltTranscript;
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
    // Resolve template: explicit template_id → user's default for mode → global preset fallback
    let chosenTemplate: { id: string; prompt: string; mode: string } | null = null;

    if (template_id) {
      const { data } = await supabase
        .from("templates")
        .select("id, prompt, mode")
        .eq("id", template_id)
        .single();
      if (data) chosenTemplate = data;
    }

    if (!chosenTemplate) {
      // Fall back to user's default template for this mode
      const { data } = await supabase
        .from("templates")
        .select("id, prompt, mode")
        .eq("user_id", userId)
        .eq("mode", mode || "consultation")
        .eq("is_default", true)
        .maybeSingle();
      if (data) chosenTemplate = data;
    }

    const patientHeader = [
      patient_name ? `Patient Name: ${patient_name}` : null,
      patient_id ? `Patient ID / NHS Number: ${patient_id}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    const defaultConsultationPrompt = `You are a professional UK clinical documentation assistant generating clinical letters for NHS doctors. Convert consultation transcripts into structured clinical letters following the exact format below.

${patientHeader ? `\n${patientHeader}\n` : ""}

OUTPUT STRUCTURE:

**Clinical Summary**

- **Presenting Complaint:** [Brief summary of the reason for consultation]
- **Diagnosis/Impression:** [Clinical diagnosis or working impression]
- **Key Findings:** [Any significant examination or investigation findings]

**Plan**

- [Management step 1]
- [Management step 2]
- [Medication changes, if any]
- [Investigations requested, if any]
- [Follow-up arrangements]
- [Safety-netting advice given]

---

**Dear Dr [GP Name],**

Thank you for referring [Patient Name / this patient] who I saw [today / on DATE] in clinic.

**History**

[Write the full history as flowing narrative prose. Include presenting complaint, duration, associated symptoms, relevant past medical history, drug history, allergies, family history, and social history as relevant.]

**Examination**

[Write examination findings as flowing narrative. Include relevant positive and negative findings. If no formal examination was performed, omit this section.]

**Investigations**

[List any investigations performed or requested. Include results if discussed. Omit if none.]

**Impression**

[Clinical impression and reasoning, as narrative.]

**Management Plan**

[Narrative description of the management plan, including medications prescribed, investigations requested, advice given, and follow-up arrangements. What was discussed and agreed with the patient.]

Thank you once again for your referral. Please do not hesitate to contact me if you require any further information.

**Kind regards,**

Dr [Doctor Name]
[Role/Specialty]

---

RULES:
- Use the structure above exactly, with Markdown-style bold headings
- The Clinical Summary and Plan sections at the top use bullet points for quick reference
- The letter body uses flowing narrative prose under each heading (no bullets in History, Examination, Impression)
- Extract the GP name, doctor name, patient details, and consultation date from the transcript where available; otherwise use bracketed placeholders
- Never fabricate clinical details. If information is unclear or missing, use "[not documented]" or omit the section
- Use formal UK medical letter conventions and British English spelling (e.g. "paracetamol", not "acetaminophen")
- Use UK medication names, NHS terminology, and NICE-consistent language
- Be thorough: include ALL relevant clinical information from the transcript
- Do not add a Safeguarding or DVLA note unless explicitly raised in the transcript`;

    const defaultDictationPrompt = `You are a professional UK clinical documentation assistant. The following is a dictated clinical note. Clean it up into a well-structured, professional clinical document while preserving all clinical details exactly as dictated.

${patientHeader ? `\n${patientHeader}\n` : ""}

OUTPUT STRUCTURE (use Markdown bold headings; omit sections not covered in the dictation):

**Presenting Complaint**
[Narrative]

**History of Presenting Complaint**
[Narrative]

**Past Medical History**
[Narrative or list]

**Drug History & Allergies**
[Narrative or list]

**Social History**
[Narrative]

**Examination**
[Narrative]

**Investigations**
[Narrative]

**Impression**
[Narrative]

**Plan**
- [Bullet points for actions]

RULES:
- Correct grammar, punctuation, and formatting but do NOT change clinical meaning
- Remove filler words, false starts, and repetitions
- Use formal UK medical conventions and British English spelling
- Use UK medication names and NHS terminology
- Do not fabricate or infer any clinical details not present in the dictation
- Preserve all medical terminology exactly as dictated
- If a section is not covered in the dictation, omit it entirely (do not write "not documented")`;

    // If a template was chosen, prepend patient header so it's always included
    const templatePrompt = chosenTemplate
      ? (patientHeader ? `${patientHeader}\n\n${chosenTemplate.prompt}` : chosenTemplate.prompt)
      : null;

    const systemPrompt = templatePrompt
      ? templatePrompt
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
        patient_name: patient_name || null,
        patient_id: patient_id || null,
        template_id: chosenTemplate?.id || null,
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
