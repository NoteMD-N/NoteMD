import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

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

    // Step 1: Transcribe with OpenAI Whisper
    const formData = new FormData();
    formData.append("file", audioData, "audio.webm");
    formData.append("model", "whisper-1");
    formData.append("language", "en");

    const whisperResponse = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: formData,
    });

    if (!whisperResponse.ok) {
      const errText = await whisperResponse.text();
      console.error("Whisper error:", errText);
      await supabase.from("recordings").update({ status: "error" }).eq("id", recording_id);
      throw new Error(`Transcription failed: ${errText}`);
    }

    const { text: transcript } = await whisperResponse.json();

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
