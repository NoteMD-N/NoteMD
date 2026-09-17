import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { logAudit } from "../_shared/audit.ts";

/**
 * Letter states a clinician has signed off.
 *
 * 'draft' is deliberately absent: it is the state AI generation produces, and
 * generation is not approval. 'exported' is present so re-sending a letter
 * that has already gone out is still possible.
 */
const APPROVED_FOR_SEND = ["reviewed", "exported"];
import { redactVendorError } from "../_shared/redact.ts";

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

    const { letter_id, recipients } = await req.json();
    if (!letter_id) throw new Error("letter_id is required");

    // Load the letter (RLS ensures the caller can only load letters they're allowed to see)
    const { data: letter, error: letterErr } = await supabase
      .from("letters")
      .select("*")
      .eq("id", letter_id)
      .single();
    if (letterErr || !letter) throw new Error("Letter not found");

    // The approval gate.
    //
    // A letter is created in 'draft' by AI generation. It reaches 'reviewed'
    // only when the clinician saves it from the review screen, which is their
    // explicit approval. Sending is therefore refused until then — generation
    // must never be able to put clinical correspondence in front of a
    // recipient on its own.
    //
    // Enforced here rather than in the caller because this function is the
    // single route to a recipient: the UI, auto-send and any future caller
    // all pass through it.
    if (!APPROVED_FOR_SEND.includes(letter.status)) {
      await logAudit(supabase, {
        action: "letter.email_failed",
        resource: "letter",
        resourceId: letter_id,
        outcome: "denied",
        detail: { reason: "not_reviewed", status: letter.status },
      });
      return new Response(
        JSON.stringify({
          error:
            "This letter has not been reviewed yet. Open it, check the content, " +
            "and save it before sending.",
          needs_review: true,
          status: letter.status,
        }),
        { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Resolve recipient list: explicit recipients, else the user's saved auto-send recipients
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

    if (toList.length === 0) {
      throw new Error("No recipient email addresses provided.");
    }

    const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
    const FROM_ADDRESS = Deno.env.get("EMAIL_FROM_ADDRESS"); // e.g. "NoteMD <letters@yourdomain.com>"

    if (!RESEND_API_KEY || !FROM_ADDRESS) {
      // Not configured yet — report clearly so the UI can show a friendly message
      return new Response(
        JSON.stringify({
          error:
            "Email sending is not configured yet. Add your sending domain to enable this.",
          not_configured: true,
        }),
        { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const patientLine = letter.patient_name
      ? `Patient: ${letter.patient_name}${letter.patient_id ? ` (${letter.patient_id})` : ""}`
      : "";

    const subject = letter.patient_name
      ? `Clinical Letter — ${letter.patient_name}`
      : "Clinical Letter";

    // Plain-text and minimal HTML body
    const bodyText = `${patientLine ? patientLine + "\n\n" : ""}${letter.letter_content || ""}`;
    const bodyHtml = `<div style="font-family: Arial, sans-serif; white-space: pre-wrap; font-size: 14px; line-height: 1.6; color: #1e293b;">${
      patientLine ? `<p><strong>${patientLine}</strong></p>` : ""
    }${(letter.letter_content || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</div>`;

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
      console.error("Resend error:", redactVendorError(errText));
      await logAudit(supabase, {
        action: "letter.email_failed",
        resource: "letter",
        resourceId: letter_id,
        outcome: "failure",
        detail: { provider: "resend", http_status: resendResponse.status, recipients: toList.length },
      });
      throw new Error("Failed to send email. Please try again.");
    }

    // Sending metadata only: sender, record, recipient count, outcome. The
    // letter itself is not duplicated into the trail.
    await logAudit(supabase, {
      action: "letter.emailed",
      resource: "letter",
      resourceId: letter_id,
      detail: {
        provider: "resend",
        recipients: toList.length,
        status_before_send: letter.status ?? null,
      },
    });

    // Mark the letter as exported
    await supabase
      .from("letters")
      .update({ status: "exported" })
      .eq("id", letter_id);

    await logAudit(supabase, {
      action: "letter.exported",
      resource: "letter",
      resourceId: letter_id,
      detail: { via: "email", status_before_send: letter.status ?? null },
    });

    return new Response(
      JSON.stringify({ success: true, sent_to: toList }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("send-letter-email error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
