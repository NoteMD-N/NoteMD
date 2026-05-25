import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

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

    // Load the existing letter (RLS ensures user can only load their own)
    const { data: letter, error: letterErr } = await supabase
      .from("letters")
      .select("*")
      .eq("id", letter_id)
      .single();
    if (letterErr || !letter) throw new Error("Letter not found");

    // Safety scope clause prepended to every system prompt
    const SAFETY_CLAUSE = `IMPORTANT — SCOPE OF YOUR ROLE:
- Your role is limited to formatting, structuring, summarising, and correcting grammar/spelling.
- Do NOT provide medical advice, recommendations, diagnoses, or clinical opinions beyond what the clinician has stated in the source material.
- Do NOT add medications, dosages, investigations, or follow-up arrangements that are not present in the source.
- If a clinical detail is unclear or missing, do not invent it. Use [unclear] or omit gracefully.
- The clinician is responsible for all clinical content; you assist only with documentation quality.

`;

    // The consultation transcript is the authoritative source of clinical truth. The current
    // letter is the working draft being revised. When the clinician asks for changes, the AI
    // should pull facts from the transcript — not just rearrange what's already in the letter.
    const REFINEMENT_BASE = `You are a professional UK clinical documentation assistant. You are revising a clinical letter according to the clinician's instructions.

SOURCE OF TRUTH: The CONSULTATION TRANSCRIPT below is the authoritative source of clinical information. When applying changes — especially when asked to add detail, expand a section, or include something — draw the facts from the transcript. The current letter is only the working draft; it may have omitted details that are present in the transcript.

Preserve clinical accuracy. Apply the changes requested. Use UK English and NHS terminology. Return only the revised letter text with no preamble, headings like "Revised Letter:", or commentary.`;

    let templateGuidance = "";
    if (template_id) {
      const { data: tmpl } = await supabase
        .from("templates")
        .select("prompt, name")
        .eq("id", template_id)
        .single();
      if (tmpl?.prompt) {
        templateGuidance = `\n\nADDITIONAL STRUCTURAL GUIDANCE — reformat the letter to follow this template's structure and conventions (draw all clinical detail from the transcript):\n\n${tmpl.prompt}`;
      }
    }

    const systemPrompt = SAFETY_CLAUSE + REFINEMENT_BASE + templateGuidance;

    const patientHeader = [
      letter.patient_name ? `Patient Name: ${letter.patient_name}` : null,
      letter.patient_id ? `Patient ID / NHS Number: ${letter.patient_id}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    const userPrompt = `${patientHeader ? `${patientHeader}\n\n` : ""}${
      letter.transcript
        ? `CONSULTATION TRANSCRIPT (authoritative source — draw clinical facts from here):\n\n${letter.transcript}\n\n`
        : ""
    }CURRENT LETTER DRAFT (revise this):

${letter.letter_content}

INSTRUCTIONS:

${instructions}

Return only the revised letter text. No preamble, no commentary, no "Here is the revised letter:" — just the letter itself.`;

    const gptResponse = await fetch("https://api.openai.com/v1/chat/completions", {
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

    // Update the letter
    const { error: updateErr } = await supabase
      .from("letters")
      .update({
        letter_content: newContent,
        status: "draft",
        template_id: template_id || letter.template_id,
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
