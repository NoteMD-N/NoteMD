import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { resolveTemplateSelection } from "../_shared/transcription-policy.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
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

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
    if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not configured");

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

    const { letter_id, instructions, template_id, fast } = await req.json();
    if (!letter_id || !instructions) {
      throw new Error("letter_id and instructions are required");
    }
    // The client sends the string "none" when the user picks "No template —
    // follow my instructions only". Distinguish it from `undefined` (keep the
    // letter's current template) and from a real UUID (switch templates).
    //
    // Any non-UUID sentinel other than "none" (from an unknown future client)
    // is treated as "no template" rather than being passed to Postgres, which
    // would otherwise fail with "invalid input syntax for type uuid" and
    // surface as the generic "non-2xx" error in the UI.
    const { noTemplate, effectiveTemplateId, isValidUuid } =
      resolveTemplateSelection(template_id);

    // Load the existing letter (RLS ensures user can only load their own)
    const { data: letter, error: letterErr } = await supabase
      .from("letters")
      .select("*")
      .eq("id", letter_id)
      .single();
    if (letterErr || !letter) throw new Error("Letter not found");

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

    // Enhanced Recovery Mode — actively recover clinically-relevant content from the
    // transcript when the user asks to expand/improve, rather than only rewriting the draft.
    const REFINEMENT_BASE = `You are revising a clinical letter according to the clinician's instructions.

SOURCE OF TRUTH
The consultation transcript is the authoritative source of clinical information.
The current letter draft may be incomplete.

When asked to:
- Expand
- Add detail
- Improve
- Make comprehensive
- Include omitted information
- Strengthen the letter
- Improve quality

you MUST re-review the ENTIRE transcript and actively recover clinically relevant information that may have been omitted from the draft.
DO NOT merely rewrite existing text.
You MUST identify additional factual content present in the transcript and incorporate it where appropriate.

WHEN EXPANDING A LETTER:
- Recover omitted symptoms.
- Recover chronology.
- Recover relevant positive findings.
- Recover relevant negative findings.
- Recover investigation details.
- Recover management discussions.
- Recover patient concerns.
- Recover functional impact.
- Recover shared decision-making.
- Recover clinician reasoning.
- Recover differential diagnoses discussed.

PRIORITY ORDER
1. Clinical accuracy.
2. Completeness.
3. Chronology.
4. Readability.
5. Conciseness.

Use consultant-level NHS correspondence style.
Use British English.
Do not write in bold.
Return only the revised letter — no preamble, no commentary, no "Revised Letter:" heading.`;

    // Only apply template guidance when the client explicitly asked for a template switch.
    // "No template" bypasses everything and tells the AI to ignore the draft's existing
    // structure — it should work purely from the transcript + user instructions.
    let templateGuidance = "";
    if (!noTemplate && effectiveTemplateId) {
      // maybeSingle so a stale/deleted template id doesn't 500 the request —
      // we just fall back to no template guidance.
      const { data: tmpl } = await supabase
        .from("templates")
        .select("prompt, name")
        .eq("id", effectiveTemplateId)
        .maybeSingle();
      if (tmpl?.prompt) {
        templateGuidance = `\n\nADDITIONAL STRUCTURAL GUIDANCE — reformat the letter to follow this template's structure and conventions (draw all clinical detail from the transcript):\n\n${tmpl.prompt}`;
      }
    }

    const NO_TEMPLATE_CLAUSE = noTemplate
      ? `\n\nTEMPLATE OVERRIDE — NO TEMPLATE
The clinician has explicitly opted out of any template. Do NOT preserve the current draft's
section structure, headings, or ordering when they conflict with the clinician's instructions.
Follow the clinician's instructions verbatim. If they ask for a plain paragraph, produce a plain
paragraph. If they ask for a specific ordering, use that ordering. Draw clinical content only
from the transcript (authoritative source) and the current draft (secondary). Return only the
revised letter.`
      : "";

    const systemPrompt = SAFETY_CLAUSE + REFINEMENT_BASE + templateGuidance + NO_TEMPLATE_CLAUSE;

    const patientHeader = [
      letter.patient_name ? `Patient Name: ${letter.patient_name}` : null,
      letter.patient_id ? `Patient ID / NHS Number: ${letter.patient_id}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    const userPrompt = `${patientHeader ? `[Patient Name / ID]\n${patientHeader}\n\n` : ""}${
      letter.transcript
        ? `CONSULTATION TRANSCRIPT (AUTHORITATIVE SOURCE)\n${letter.transcript}\n\n`
        : ""
    }CURRENT LETTER DRAFT\n${letter.letter_content}\n\nINSTRUCTIONS\n${instructions}\n\nReturn only the revised letter.`;

    const gptResponse = await fetch(openAiUrl("chat/completions"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        // Fast model for quick refinements (grammar, structure, simple changes); full model for template switches and big rewrites
        model: fast ? "gpt-4o-mini" : "gpt-4o",
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
      throw new Error(`Regeneration failed: ${errText}`);
    }

    const gptData = await gptResponse.json();
    const newContent = gptData.choices[0].message.content;

    // Update the letter. When the user picked "No template", detach the template from the letter
    // so subsequent regenerations don't silently inherit it again.
    const { error: updateErr } = await supabase
      .from("letters")
      .update({
        letter_content: newContent,
        status: "draft",
        template_id: noTemplate
          ? null
          : isValidUuid
          ? effectiveTemplateId
          : letter.template_id, // keep whatever was on the letter — never write a non-UUID
      })
      .eq("id", letter_id);

    if (updateErr) throw updateErr;

    return new Response(
      JSON.stringify({ letter_content: newContent, success: true }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("regenerate-letter error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
