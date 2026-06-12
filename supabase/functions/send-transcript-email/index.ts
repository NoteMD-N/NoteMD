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

    const { transcript, patient_name, patient_id, recipients } = await req.json();
    if (!transcript || !String(transcript).trim()) {
      throw new Error("Transcript content is required");
    }

    // Recipients: explicit list or fall back to saved auto-send list
    let toList: string[] = Array.isArray(recipients) ? recipients : [];
    if (toList.length === 0) {
      const { data: profile } = await supabase
        .from("profiles")
        .select("auto_send_recipients")
        .eq("user_id", user.id)
        .single();
      toList = profile?.auto_send_recipients ?? [];
    }
    toList = toList.map((e) => String(e).trim()).filter(Boolean);
    if (toList.length === 0) throw new Error("No recipient email addresses provided.");

    const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
    const FROM_ADDRESS = Deno.env.get("EMAIL_FROM_ADDRESS");
    if (!RESEND_API_KEY || !FROM_ADDRESS) {
      return new Response(
        JSON.stringify({
          error: "Email sending is not configured yet. Add your sending domain to enable this.",
          not_configured: true,
        }),
        { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const patientLine = patient_name
      ? `Patient: ${patient_name}${patient_id ? ` (${patient_id})` : ""}`
      : "";

    const subject = patient_name
      ? `Consultation Transcript — ${patient_name}`
      : "Consultation Transcript";

    const intro = "Consultation transcript (no clinical letter generated yet):";
    const safeTranscript = String(transcript).trim();

    const bodyText = `${patientLine ? patientLine + "\n\n" : ""}${intro}\n\n${safeTranscript}`;
    const escape = (s: string) =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const bodyHtml = `<div style="font-family: Arial, sans-serif; white-space: pre-wrap; font-size: 14px; line-height: 1.6; color: #1e293b;">${
      patientLine ? `<p><strong>${escape(patientLine)}</strong></p>` : ""
    }<p style="color:#475569;">${escape(intro)}</p><div>${escape(safeTranscript)}</div></div>`;

    const resendResponse = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to: toList,
        subject,
        text: bodyText,
        html: bodyHtml,
      }),
    });

    if (!resendResponse.ok) {
      const errText = await resendResponse.text();
      console.error("[send-transcript-email] Resend error:", errText);
      throw new Error("Failed to send email. Please try again.");
    }

    return new Response(
      JSON.stringify({ success: true, sent_to: toList }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("send-transcript-email error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
