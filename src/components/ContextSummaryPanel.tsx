/**
 * The context summary, shown beside the work it is background for.
 *
 * Appears on the transcript review screen and again on the letter, because
 * those are the two moments a clinician is checking what was recorded against
 * what they remember — which is exactly when the previous correspondence is
 * worth having to hand.
 *
 * It is reference material and says so. This summary did not contribute to the
 * letter, has not been checked against the source documents, and where the
 * sources were scanned it is a model's reading of a photograph. Presenting it
 * without that framing, beside a letter, would invite it being trusted as part
 * of the record.
 *
 * Collapsed by default: the clinician's task on both screens is the clinical
 * text, not this.
 */

import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { ChevronDown, FileText } from "lucide-react";

interface Props {
  /** The consultation this context was gathered for. */
  recordingId: string | null | undefined;
}

export default function ContextSummaryPanel({ recordingId }: Props) {
  const [summary, setSummary] = useState<string | null>(null);

  useEffect(() => {
    if (!recordingId) {
      setSummary(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from("consultation_contexts")
        .select("summary")
        .eq("recording_id", recordingId)
        .eq("summary_status", "ready")
        .maybeSingle();
      if (cancelled) return;
      if (error) {
        // Absent context is the normal case, not a failure worth surfacing.
        console.warn("[context] Could not load the summary:", error.message);
        return;
      }
      setSummary(data?.summary ?? null);
    })();
    return () => { cancelled = true; };
  }, [recordingId]);

  if (!summary) return null;

  return (
    <div className="rounded-2xl border border-border/60 bg-muted/30">
      <details className="group">
        <summary className="cursor-pointer list-none p-4 flex items-center gap-2 text-sm text-muted-foreground font-heading hover:text-foreground transition-colors">
          <FileText className="h-4 w-4 shrink-0" />
          Background from uploaded documents
          <span className="text-xs font-normal">· reference only</span>
          <ChevronDown className="h-4 w-4 ml-auto transition-transform group-open:rotate-180" />
        </summary>
        <div className="px-4 pb-4">
          <p className="text-sm whitespace-pre-wrap leading-relaxed text-foreground">
            {summary}
          </p>
          <p className="mt-3 text-xs text-muted-foreground">
            Generated from the documents uploaded before this consultation. It was not
            used to write the letter and has not been checked against the originals —
            where a source was scanned, this is a reading of the page image.
          </p>
        </div>
      </details>
    </div>
  );
}
