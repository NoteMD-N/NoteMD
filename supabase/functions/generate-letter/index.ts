import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// ============================================================
// GCP identity token (for Cloud Run private service auth)
// ============================================================
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

function contentTypeFor(path: string): string {
  const ext = (path.split(".").pop() || "webm").toLowerCase();
  return CONTENT_TYPE_MAP[ext] || "audio/webm";
}

// Dictation transcription: medical-domain ASR via private Cloud Run service.
async function transcribeDictation(audioBlob: Blob, audioPath: string): Promise<string> {
  const MEDASR_URL = Deno.env.get("MEDASR_URL");
  const GCP_SERVICE_ACCOUNT_KEY = Deno.env.get("GCP_SERVICE_ACCOUNT_KEY");
  const MEDASR_API_KEY = Deno.env.get("MEDASR_API_KEY");
  if (!MEDASR_URL) throw new Error("Dictation transcription service is not configured");

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
    console.error("[transcribe-dictation] HTTP", resp.status, body.slice(0, 500));
    throw new Error(`Dictation transcription failed (HTTP ${resp.status})`);
  }
  const result = await resp.json();
  const text = (result.text || "").trim();
  if (!text) throw new Error("Dictation transcription returned no speech");
  return text;
}

// Consultation transcription: streaming-provider's pre-recorded endpoint.
async function transcribeConsultation(audioBlob: Blob, audioPath: string): Promise<string> {
  const DEEPGRAM_API_KEY = Deno.env.get("DEEPGRAM_API_KEY");
  if (!DEEPGRAM_API_KEY) throw new Error("Consultation transcription service is not configured");

  const contentType = contentTypeFor(audioPath);
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
    console.error("[transcribe-consultation] HTTP", resp.status, body.slice(0, 500));
    throw new Error(`Consultation transcription failed (HTTP ${resp.status})`);
  }
  const result = await resp.json();
  const text = (result?.results?.channels?.[0]?.alternatives?.[0]?.transcript || "").trim();
  if (!text) throw new Error("Consultation transcription returned no speech");
  return text;
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

    let transcript = "";
    const clientTranscript = (preBuiltTranscript || "").trim();
    const isDictation = mode === "dictation";

    // Decide whether we need server-side transcription:
    //  - Dictation: always re-transcribe with the medical ASR engine (preferred for accuracy).
    //  - Consultation: only re-transcribe if the client didn't supply a transcript (uploaded file
    //    or signal-drop fallback). Live, user-edited transcript wins otherwise.
    const needsServerTranscription = isDictation || !clientTranscript;

    if (needsServerTranscription) {
      if (!audio_path) {
        if (clientTranscript) {
          // No audio to fall back to — accept the client transcript rather than erroring.
          transcript = clientTranscript;
        } else {
          throw new Error("audio_path is required when transcript is not provided");
        }
      } else {
        // Download audio from storage
        console.log(`[generate-letter] Downloading audio: ${audio_path} (mode=${mode || "consultation"})`);
        const { data: audioData, error: downloadError } = await supabase.storage
          .from("audio-recordings")
          .download(audio_path);
        if (downloadError) {
          // If the download fails but we have a client transcript, use it instead of failing hard.
          console.error(`[generate-letter] Audio download failed: ${downloadError.message}`);
          if (clientTranscript) {
            console.log("[generate-letter] Falling back to client transcript");
            transcript = clientTranscript;
          } else {
            throw new Error(`Failed to download audio: ${downloadError.message}`);
          }
        } else {
          await supabase
            .from("recordings")
            .update({ status: "processing" })
            .eq("id", recording_id);

          try {
            transcript = isDictation
              ? await transcribeDictation(audioData, audio_path)
              : await transcribeConsultation(audioData, audio_path);
            console.log(`[generate-letter] Server transcription succeeded (${transcript.length} chars)`);
          } catch (err) {
            console.error("[generate-letter] Server transcription failed:", err);
            // If the user has an on-screen transcript (e.g. live capture before a disconnect),
            // use it as a fallback so the doctor never ends up with a blank letter.
            if (clientTranscript) {
              console.log("[generate-letter] Falling back to client transcript");
              transcript = clientTranscript;
            } else {
              await supabase.from("recordings").update({ status: "error" }).eq("id", recording_id);
              throw new Error(
                "Could not transcribe the audio. Please try recording again."
              );
            }
          }
        }
      }
    } else {
      transcript = clientTranscript;
    }

    if (!transcript.trim()) {
      await supabase.from("recordings").update({ status: "error" }).eq("id", recording_id);
      throw new Error("No transcript available to generate a letter.");
    }

    await supabase
      .from("recordings")
      .update({ status: "transcribed" })
      .eq("id", recording_id);

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

    // Safety scope clause prepended to every system prompt
    const SAFETY_CLAUSE = `IMPORTANT — SCOPE OF YOUR ROLE:
- Your role is limited to formatting, structuring, summarising, and correcting grammar/spelling.
- Do NOT provide medical advice, recommendations, diagnoses, or clinical opinions beyond what the clinician has stated in the source material.
- Do NOT add medications, dosages, investigations, or follow-up arrangements that are not present in the source.
- If a clinical detail is unclear or missing, do not invent it. Use [unclear] or omit gracefully.
- The clinician is responsible for all clinical content; you assist only with documentation quality.

`;

    // If a template was chosen, prepend patient header so it's always included
    const templatePrompt = chosenTemplate
      ? (patientHeader ? `${patientHeader}\n\n${chosenTemplate.prompt}` : chosenTemplate.prompt)
      : null;

    const basePrompt = templatePrompt
      ? templatePrompt
      : mode === "dictation"
      ? defaultDictationPrompt
      : defaultConsultationPrompt;

    const systemPrompt = SAFETY_CLAUSE + basePrompt;

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

    // Auto-send by email if the clinician has enabled it and has saved recipients
    try {
      const { data: prof } = await supabase
        .from("profiles")
        .select("auto_send_enabled, auto_send_recipients")
        .eq("user_id", userId)
        .single();

      if (prof?.auto_send_enabled && (prof.auto_send_recipients?.length ?? 0) > 0) {
        const emailResp = await fetch(
          `${Deno.env.get("SUPABASE_URL")}/functions/v1/send-letter-email`,
          {
            method: "POST",
            headers: {
              Authorization: authHeader,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ letter_id: letter.id }),
          }
        );
        if (!emailResp.ok) {
          console.warn("Auto-send email did not complete:", await emailResp.text());
        }
      }
    } catch (e) {
      // Never fail letter generation because of an email problem
      console.warn("Auto-send email error (non-fatal):", e);
    }

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
