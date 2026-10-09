import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { redactError } from "../_shared/redact.ts";
import { checkRateLimit, rateLimitedResponse } from "../_shared/rate-limit.ts";
import { logAudit } from "../_shared/audit.ts";
import {
  authHeaders,
  chatCompletionsUrl,
  processingRegion,
  resolveAiConfig,
} from "../_shared/ai-provider.ts";
import { CONTEXT_SUMMARY_PROMPT, MAX_CONTEXT_CHARS } from "../_shared/context-summary.ts";

/**
 * Summarises the documents a clinician uploaded as background for a
 * consultation.
 *
 * **This output never reaches letter generation.** It is shown beside the
 * transcript as reference for the clinician, and that separation is the whole
 * safety argument for the feature. A summary that says "known hypertensive, on
 * amlodipine 10mg" reads as established history; if it fed the letter, an
 * error in it would be asserted as fact in correspondence, and nobody opens
 * the source PDF to check. Kept as reference, the same error is something a
 * clinician reads with their own judgement engaged.
 *
 * Scanned documents arrive as page images and are read by the same vision
 * model we already use for letters — no new processor, no new region, no
 * additional data processing agreement.
 */

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
      { global: { headers: { Authorization: authHeader } } },
    );

    const { data: { user }, error: userErr } = await supabase.auth.getUser();
    if (userErr || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const rl = await checkRateLimit(supabase, "summarise-context");
    if (!rl.allowed) return rateLimitedResponse("summarise-context", rl, corsHeaders);

    const { context_id } = await req.json();
    if (!context_id) throw new Error("context_id is required");

    // Read through the caller's own client, so row-level security decides
    // whether this context belongs to them. The service role is deliberately
    // not used: it would see every clinician's documents.
    const { data: context, error: contextErr } = await supabase
      .from("consultation_contexts")
      .select("id, user_id")
      .eq("id", context_id)
      .maybeSingle();
    if (contextErr || !context) {
      return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: documents, error: docsErr } = await supabase
      .from("context_documents")
      .select("id, file_name, file_path, content_type, extracted_text, extraction_method")
      .eq("context_id", context_id)
      .order("created_at", { ascending: true });
    if (docsErr) throw new Error(docsErr.message);

    if (!documents || documents.length === 0) {
      return new Response(JSON.stringify({ error: "No documents to summarise" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    await supabase
      .from("consultation_contexts")
      .update({ summary_status: "pending" })
      .eq("id", context_id);

    const config = resolveAiConfig((name) => Deno.env.get(name));

    // Text where we have it; page images where the document was scanned.
    const parts: Array<Record<string, unknown>> = [];
    let textChars = 0;
    let usedOcr = false;

    for (const doc of documents) {
      if (doc.extracted_text && doc.extracted_text.trim()) {
        const remaining = MAX_CONTEXT_CHARS - textChars;
        if (remaining <= 0) break;
        const body = doc.extracted_text.slice(0, remaining);
        textChars += body.length;
        parts.push({ type: "text", text: `--- ${doc.file_name} ---\n${body}` });
        continue;
      }

      // No text: the pages were uploaded as images for reading.
      usedOcr = true;
      const { data: file, error: dlErr } = await supabase.storage
        .from("context-documents")
        .download(doc.file_path);
      if (dlErr || !file) {
        console.warn(`[summarise-context] could not read ${doc.id}: ${dlErr?.message}`);
        continue;
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (const b of bytes) binary += String.fromCharCode(b);
      parts.push({ type: "text", text: `--- ${doc.file_name} (scanned) ---` });
      parts.push({
        type: "image_url",
        image_url: { url: `data:${doc.content_type};base64,${btoa(binary)}` },
      });
    }

    if (parts.length === 0) throw new Error("Nothing could be read from the uploaded documents");

    const resp = await fetch(chatCompletionsUrl(config, config.letterModel), {
      method: "POST",
      headers: { ...authHeaders(config), "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.letterModel,
        messages: [
          { role: "system", content: CONTEXT_SUMMARY_PROMPT },
          { role: "user", content: parts },
        ],
        temperature: 0,
      }),
      signal: AbortSignal.timeout(120000),
    });

    if (!resp.ok) {
      const detail = await resp.text();
      console.error(`[summarise-context] provider returned ${resp.status}: ${detail.slice(0, 300)}`);
      await supabase
        .from("consultation_contexts")
        .update({ summary_status: "failed" })
        .eq("id", context_id);
      throw new Error("The documents could not be summarised");
    }

    const region = processingRegion(resp.headers);
    const body = await resp.json();
    const summary = (body?.choices?.[0]?.message?.content || "").trim();
    if (!summary) throw new Error("The documents could not be summarised");

    await supabase
      .from("consultation_contexts")
      .update({ summary, summary_status: "ready" })
      .eq("id", context_id);

    // Counts and method, never content: the audit trail records that
    // documents were read, not what was in them.
    await logAudit(supabase, {
      action: "context.summarised",
      resource: "consultation_context",
      resourceId: context_id,
      detail: {
        documents: documents.length,
        used_ocr: usedOcr,
        summary_chars: summary.length,
        processing_region: region,
      },
    });

    console.log(
      `[summarise-context] context=${context_id} docs=${documents.length} ocr=${usedOcr} ` +
      `region=${region ?? "n/a"} chars=${summary.length}`,
    );

    return new Response(
      JSON.stringify({ summary, used_ocr: usedOcr, documents: documents.length }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    console.error("summarise-context error:", redactError(error));
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
