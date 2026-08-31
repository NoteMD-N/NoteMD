import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  resolveProvider,
  shouldServerTranscribe,
  resolveTemplateSelection,
  buildBatchUrl,
} from "../_shared/transcription-policy.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { redactVendorError } from "../_shared/redact.ts";

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
    console.error("[transcribe-dictation] HTTP", resp.status, redactVendorError(body));
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
    console.error("[transcribe-consultation] HTTP", resp.status, redactVendorError(body));
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
      // When present, the client has already run transcription (e.g. medical ASR
      // via the transcribe-audio function). We trust the transcript as-is and
      // skip server-side re-transcription.
      transcript_source,
      mode,
      patient_name,
      patient_id,
      template_id,
    } = await req.json();

    if (!recording_id) {
      throw new Error("recording_id is required");
    }

    // Monthly letter quota — only enforced once Stripe is fully configured AND the user
    // is not flagged as quota-exempt. This avoids accidentally blocking real users in
    // dev/staging or while billing is still being wired up.
    const billingConfigured = !!Deno.env.get("STRIPE_PRICE_ID") &&
      !!Deno.env.get("STRIPE_SECRET_KEY");

    if (billingConfigured) {
      const { data: subscription } = await supabase
        .from("subscriptions")
        .select("plan, status, letters_per_month, quota_exempt")
        .eq("user_id", userId)
        .maybeSingle();

      const isExempt = (subscription as any)?.quota_exempt === true;
      const lettersPerMonth = subscription?.letters_per_month ?? 20;
      const isActive = subscription?.status === "active" || subscription?.status === "trialing";
      const isFreeTier = !subscription || subscription.plan === "free" || !isActive;

      if (!isExempt && isFreeTier) {
        const { data: usageRow } = await supabase
          .from("letter_usage_current_month")
          .select("letters_this_month")
          .eq("user_id", userId)
          .maybeSingle();
        const used = usageRow?.letters_this_month ?? 0;
        if (used >= lettersPerMonth) {
          return new Response(
            JSON.stringify({
              error: `You've used your ${lettersPerMonth} free letters for this month. Upgrade to keep generating.`,
              quota_exceeded: true,
              used,
              limit: lettersPerMonth,
            }),
            { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
      }
    }

    let transcript = "";
    const clientTranscript = (preBuiltTranscript || "").trim();
    const isDictation = mode === "dictation";

    // Look up the user's dictation engine preference ('fast' = streaming provider,
    // 'accurate' = medical ASR). Defaults to 'accurate' when not set.
    let dictationEngine: "fast" | "accurate" = "accurate";
    if (isDictation) {
      const { data: prefRow } = await supabase
        .from("profiles")
        .select("dictation_engine")
        .eq("user_id", userId)
        .maybeSingle();
      const v = (prefRow as any)?.dictation_engine;
      if (v === "fast" || v === "accurate") dictationEngine = v;
    }

    // Decide whether we need server-side transcription:
    //  - If the client explicitly says the transcript is authoritative
    //    (transcript_source === "medical" or "client"), trust it — no re-transcribe.
    //  - Dictation (accurate engine): re-transcribe via medical ASR.
    //  - Dictation (fast engine): trust the client transcript if present.
    //  - Consultation: only re-transcribe if no client transcript (uploaded file or full drop).
    const needsServerTranscription = shouldServerTranscribe({
      transcriptSource: transcript_source,
      clientTranscript,
      isDictation,
      dictationEngine,
    });

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
            // Same resolver as transcribe-audio, so a server-side fallback
            // yields text from the same engine the clinician was shown.
            const serverProvider = isDictation
              ? resolveProvider(dictationEngine, Deno.env.get("TRANSCRIBE_ACCURATE_PROVIDER"))
              : "deepgram";
            transcript =
              serverProvider === "openai"
                ? await transcribeOpenAI(audioData, audio_path)
                : serverProvider === "medasr"
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

    // Pull the clinician's display details so the AI can populate the letter signature.
    const { data: clinicianProfile } = await supabase
      .from("profiles")
      .select("full_name, role_title, hospital_organisation")
      .eq("user_id", userId)
      .maybeSingle();

    const clinicianBlock = [
      clinicianProfile?.full_name ? `Clinician: Dr ${clinicianProfile.full_name}` : null,
      clinicianProfile?.role_title ? `Role: ${clinicianProfile.role_title}` : null,
      clinicianProfile?.hospital_organisation
        ? `Hospital / Organisation: ${clinicianProfile.hospital_organisation}`
        : null,
    ]
      .filter(Boolean)
      .join("\n");

    const signatureGuidance = clinicianBlock
      ? `\n\nCLINICIAN DETAILS (use these in the letter signature exactly as written; do not invent or alter):\n${clinicianBlock}\n`
      : "";

    const defaultConsultationPrompt = `You are an expert UK clinical documentation assistant specialising in consultant-level outpatient correspondence.
Your task is to convert consultation transcripts into highly detailed, comprehensive, professional clinic letters suitable for communication between hospital specialists, general practitioners, multidisciplinary teams, and future treating clinicians.
Your primary objective is to capture ALL clinically relevant information contained within the consultation transcript.
Do not prioritise brevity.
Prioritise completeness, chronology, clarity, and clinical accuracy.
Where information appears fragmented throughout the consultation, reconstruct it into a coherent clinical narrative whilst preserving the original meaning.
The consultation transcript is the sole authoritative source of clinical information.
Your responsibility is to ensure that ALL clinically relevant information contained within the transcript is accurately captured and organised into a clear, coherent, and comprehensive clinical letter.
Assume that the consultation transcript may not be available in the future. Therefore, ensure that all clinically relevant information required for future patient care is preserved within the final letter.
Unless specifically instructed otherwise, favour inclusion of clinically relevant information over summarisation.

Generate correspondence that would allow a clinician unfamiliar with the patient to understand:
- Why the patient attended.
- What symptoms were described.
- What findings were identified.
- What diagnoses were considered.
- Why those diagnoses were considered.
- What management decisions were made.
- What was agreed with the patient.

The letter should be suitable for future clinical review, multidisciplinary discussion, and medico-legal scrutiny.

Prioritise:
- Clinical accuracy.
- Completeness.
- Chronology.
- Readability.

PATIENT DETAILS
${patient_name || "[Patient Name]"}
${patient_id || "[NHS Number / Patient ID]"}

CLINICAL INFORMATION EXTRACTION REQUIREMENTS

Before generating the letter:
- Carefully review the entire consultation transcript.
- Identify and extract all clinically relevant information, including information that may be scattered throughout different parts of the consultation.

Clinical information may appear:
- During history taking.
- During examination.
- During discussion of investigations.
- During management planning.
- During patient questions.
- During clinician explanations.
- During diagnostic reasoning.

Do not omit information simply because:
- It is mentioned more than once.
- It appears later in the consultation.
- It appears during discussion rather than formal history taking.
- It appears within patient questions.
- It appears within clinician reasoning.

Actively identify and extract:
- Presenting symptoms.
- Symptom chronology.
- Symptom progression.
- Relevant positive findings.
- Relevant negative findings.
- Functional impact.
- Occupational impact.
- Driving implications.
- Patient concerns.
- Patient expectations.
- Previous diagnoses.
- Previous investigations.
- Previous treatments.
- Medication response.
- Medication adverse effects.
- Examination findings.
- Investigation findings.
- Diagnostic reasoning.
- Shared decision-making discussions.
- Follow-up plans.

The final letter should contain all clinically relevant information from the consultation.

OUTPUT STRUCTURE

CLINICAL SUMMARY
Diagnosis:
- Write the diagnosis of this presentation (Primary diagnosis or working diagnosis).
- List the previous diagnoses in points.

Plan:
Summarise the plan of this visit in points, and include the following:
- Management decisions.
- Medication changes.
- Investigations arranged.
- Referrals arranged.
- Follow-up plans.
- Safety-netting discussed.

Dear Dr [GP Name],
Thank you for referring [Patient Name], whom I reviewed [today/on DATE].
(write the following as a text, no subheading, no bullet points, no bold)

(HISTORY)
Produce a detailed narrative account of the consultation.
The history should be comprehensive and should include ALL clinically relevant information mentioned anywhere within the transcript.

Where available include:

Presenting symptoms:
- Symptom onset.
- Duration.
- Evolution over time.
- Frequency.
- Severity.
- Pattern.
- Triggers.
- Relieving factors.
- Associated symptoms.
- Relevant negative symptoms.

Chronology:
- Clear timeline of symptom development.
- Previous episodes.
- Disease progression.
- Response to previous treatments.

Impact:
- Functional impact.
- Occupational impact.
- Educational impact.
- Driving implications if discussed.
- Psychological impact if discussed.
- Quality-of-life impact if discussed.

Relevant background:
- Past medical history.
- Surgical history.
- Drug history.
- Allergies.
- Family history.
- Social history.
- Smoking history.
- Alcohol history.
- Travel history.
- Recreational drug use if discussed.

Previous assessments:
- Specialist reviews.
- Previous diagnoses.
- Previous investigations.
- Previous treatments.

Patient perspective:
- Concerns.
- Expectations.
- Questions raised.
- Preferences.
- Understanding of their condition.

IMPORTANT:
- Do not simply list information.
- Construct a coherent specialist narrative using fluent professional medical language.
- Include all clinically relevant positive and negative findings.
- Capture nuances and details that contribute to diagnostic reasoning.

(EXAMINATION)
Provide a detailed narrative description of examination findings.
Include:
- Relevant positive findings.
- Relevant negative findings.
- Neurological examination findings.
- General examination findings.
- Mental state findings if discussed.
- Cognitive findings if discussed.

If examination findings are discussed across different parts of the consultation, integrate them into a single coherent examination section.
If no examination was performed or documented, omit this section.

(INVESTIGATIONS)
Provide a comprehensive summary of:
- Investigations reviewed.
- Historical investigations.
- Investigations performed.
- Investigations requested.
- Results discussed.

Include:
- Imaging findings.
- Neurophysiology findings.
- Blood test results.
- Lumbar puncture findings.
- Cardiac investigations.
- Genetic testing.
- Any relevant numerical results where available.

Present findings accurately without interpretation beyond that stated by the clinician.

(IMPRESSION AND PLAN)
Provide a detailed narrative account of the clinician's impression.
Include:
- Primary diagnosis.
- Working diagnosis.
- Differential diagnoses discussed.
- Diagnostic reasoning explicitly stated.
- Interpretation of symptoms.
- Interpretation of examination findings.
- Interpretation of investigations.
- Degree of diagnostic certainty.
- Areas of uncertainty.

The Impression section should faithfully reflect the clinician's diagnostic reasoning process.
Where the clinician discusses why a diagnosis is considered likely or unlikely, include this reasoning.
Where differential diagnoses are considered, explain the factors supporting or arguing against each diagnosis if discussed.
Preserve diagnostic uncertainty where uncertainty exists.
Do not simplify nuanced clinical reasoning.
Do not introduce any new opinion or interpretation.

Provide a detailed narrative account of the management discussion.
Document the management discussion in detail to reflect the content of the consultation.

Include:
- Advice provided.
- Treatment options discussed and decision.
- Risks discussed.
- Benefits discussed.
- Alternatives discussed.
- Patient preferences.
- Questions raised by the patient.
- Shared decision-making.
- Agreed actions.
- Decisions.
- Medication changes and discussions.
- Investigations arranged.
- Referrals made.
- Monitoring plans.
- Follow-up arrangements.
- Safety-netting advice.
- Patient preferences.

Document both what was discussed and what was agreed.

Thank you for allowing me to participate in the care of this patient.
Kind regards,
Dr [Doctor Name]
[Role / Specialty]

MANDATORY RULES
- Use formal consultant-level UK correspondence style.
- Use British English throughout.
- Use UK medication names and NHS terminology.
- Extract ALL clinically relevant information from the transcript.
- Preserve chronology whenever possible.
- Capture both relevant positive and relevant negative findings.
- Include symptom characteristics in detail.
- Include functional impact whenever discussed.
- Include patient concerns and expectations whenever discussed.
- Include clinical reasoning whenever explicitly stated.
- Do not omit information merely because it appears repetitive.
- Merge fragmented information from multiple parts of the consultation into a coherent narrative.
- Do not fabricate information.
- Do not infer information.
- Do not create diagnoses.
- If uncertain, use "[unclear]".
- Prioritise completeness over brevity.
- Do not write in bold.
- Generate letters suitable for future clinical review, multidisciplinary discussion, and medico-legal scrutiny.`;

    const defaultDictationPrompt = `You are an expert UK clinical documentation assistant.
The following is a dictated clinical note.
Your task is to convert it into a highly organised, professionally formatted clinical document whilst preserving all clinical content exactly as dictated.
Write it as directed in the dictation.

${patientHeader ? `\n${patientHeader}\n\n` : ""}OUTPUT STRUCTURE:
Include the following information if mentioned:
- Presenting Complaint
- History of Presenting Complaint
- Relevant Positive Features
- Relevant Negative Features
- Past Medical History
- Past Surgical History
- Current Medications
- Drug Allergies
- Family History
- Social History
- Examination
- Investigations
- Assessment / Impression
- Plan

RULES
- Preserve clinical meaning exactly.
- Correct grammar, punctuation, spelling and formatting.
- Remove filler words and speech artefacts.
- Retain all clinically relevant information.
- Preserve chronology.
- Use British English.
- Use NHS terminology.
- Use formal professional medical language.
- Do not invent information.
- Do not infer information.
- Do not remove clinically relevant details.
- Include relevant positive and negative findings where stated.
- Omit sections not discussed.
- Do not write in bold.`;

    // Safety scope clause prepended to every system prompt
    const SAFETY_CLAUSE = `IMPORTANT — SCOPE OF YOUR ROLE

Your role is strictly limited to documentation, transcription, structuring, summarisation, organisation, and language improvement.

You must NEVER:
- Generate new diagnoses, clinical opinions, recommendations, or management plans that are not explicitly stated by the clinician.
- Introduce medications, dosages, investigations, referrals, follow-up arrangements, risks, prognostic statements, or advice that are not present in the source material.
- Infer findings that were not discussed.

You MUST:
- Preserve clinical meaning exactly.
- Distinguish clearly between clinician statements and patient-reported information.
- Preserve uncertainty where uncertainty exists.
- Use "[unclear]" where speech recognition errors or ambiguity prevent accurate interpretation.
- No invention allowed.
- Treat the transcript as the sole authoritative source of clinical content.
- Maximise completeness and accuracy of documentation without altering meaning.
- Do not write in bold.
- When generating the letter, assume that the transcript may be deleted after the letter is produced. Therefore, ensure that all clinically relevant information required for future patient care is captured within the letter.

The clinician remains entirely responsible for clinical content. Your role is documentation support only.

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

    const systemPrompt = SAFETY_CLAUSE + basePrompt + signatureGuidance;

    const userPrompt = mode === "dictation"
      ? `Please correct and enhance the following dictated note into a structured professional clinical document.\n\n[TRANSCRIPT]\n${transcript}`
      : `Please convert the following consultation transcript into a comprehensive consultant-level clinical letter using the template above. Include all clinically relevant information and preserve chronology wherever possible.\n\n[TRANSCRIPT]\n${transcript}`;

    const gptResponse = await fetch(openAiUrl("chat/completions"), {
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
      console.error("GPT error:", redactVendorError(errText));
      await supabase.from("recordings").update({ status: "error" }).eq("id", recording_id);
      // Extract a short, user-readable reason if the OpenAI response is JSON
      let short = errText.slice(0, 200);
      try {
        const parsed = JSON.parse(errText);
        short = parsed?.error?.message || parsed?.message || short;
      } catch {
        /* not JSON */
      }
      throw new Error(`Letter generation failed: ${short}`);
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
          console.warn("Auto-send email did not complete:", redactVendorError(await emailResp.text()));
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
