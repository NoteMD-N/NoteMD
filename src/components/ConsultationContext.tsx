/**
 * Background assembled before a consultation.
 *
 * Notes the clinician types or dictates, plus documents they upload —
 * previous clinic letters, results, referrals — summarised for them to read
 * before seeing the patient.
 *
 * The summary is reference material. It is deliberately not an input to
 * letter generation, and the wording here says so where a clinician will see
 * it: a summary presented as part of the letter pipeline invites being
 * trusted, and this one is a model's reading of documents, sometimes of
 * photographs of documents.
 *
 * Text is extracted in the browser. A PDF with a text layer never leaves the
 * device as an image, and only genuinely scanned pages are uploaded for
 * reading.
 */

import { useCallback, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import {
  FileText,
  Loader2,
  Mic,
  Paperclip,
  ScanLine,
  Square,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { MAX_PAGES, extractDocument, isSupportedDocument } from "@/lib/context/extract";

/** One upload, as the clinician sees it. */
interface ContextDocument {
  id: string;
  fileName: string;
  pageCount: number;
  method: "text-layer" | "ocr" | "none";
}

interface Props {
  /** Set once a context row exists, so the recording can be linked to it. */
  onContextIdChange?: (contextId: string | null) => void;
  disabled?: boolean;
}

/** Larger than this is not consultation background. */
const MAX_FILE_BYTES = 25 * 1024 * 1024;

export default function ConsultationContext({ onContextIdChange, disabled }: Props) {
  const [notes, setNotes] = useState("");
  const [documents, setDocuments] = useState<ContextDocument[]>([]);
  const [summary, setSummary] = useState<string | null>(null);
  const [usedOcr, setUsedOcr] = useState(false);

  const [uploading, setUploading] = useState(false);
  const [summarising, setSummarising] = useState(false);
  const [dictating, setDictating] = useState(false);
  const [transcribingNote, setTranscribingNote] = useState(false);

  const contextIdRef = useRef<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const noteRecorderRef = useRef<MediaRecorder | null>(null);
  const noteChunksRef = useRef<Blob[]>([]);

  /** Creates the context row on first use, so an untouched page writes nothing. */
  const ensureContext = useCallback(async (): Promise<string> => {
    if (contextIdRef.current) return contextIdRef.current;
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error("Not signed in");
    const { data, error } = await supabase
      .from("consultation_contexts")
      .insert({ user_id: user.id })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    contextIdRef.current = data.id;
    onContextIdChange?.(data.id);
    return data.id;
  }, [onContextIdChange]);

  const persistNotes = useCallback(async (value: string) => {
    if (!value.trim() && !contextIdRef.current) return;
    try {
      const id = await ensureContext();
      await supabase.from("consultation_contexts").update({ notes: value }).eq("id", id);
    } catch (err) {
      console.warn("[context] Could not save notes:", err);
    }
  }, [ensureContext]);

  // ---------------------------------------------------------------------
  // Dictating the notes
  //
  // Recorded and transcribed after Stop rather than streamed. These are a few
  // sentences typed before a consultation, not the consultation itself, so the
  // live pipeline's machinery would buy nothing here.
  // ---------------------------------------------------------------------

  const startDictation = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";
      const recorder = new MediaRecorder(stream, { mimeType });
      noteChunksRef.current = [];
      recorder.ondataavailable = (e) => { if (e.data.size > 0) noteChunksRef.current.push(e.data); };
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(noteChunksRef.current, { type: "audio/webm" });
        noteChunksRef.current = [];
        if (blob.size < 2000) return;

        setTranscribingNote(true);
        try {
          const { data: { user } } = await supabase.auth.getUser();
          if (!user) throw new Error("Not signed in");
          const path = `${user.id}/context-notes/${Date.now()}.webm`;
          const { error: upErr } = await supabase.storage
            .from("audio-recordings")
            .upload(path, blob);
          if (upErr) throw new Error(upErr.message);

          const { data, error } = await supabase.functions.invoke("transcribe-audio", {
            body: { audio_path: path, engine: "accurate" },
          });
          if (error) throw new Error(error.message);
          const text = ((data?.transcript || "") as string).trim();
          if (!text) {
            toast.error("No speech detected");
            return;
          }
          setNotes((prev) => {
            const next = prev ? `${prev} ${text}` : text;
            void persistNotes(next);
            return next;
          });
        } catch (err) {
          toast.error(err instanceof Error ? err.message : "Could not transcribe");
        } finally {
          setTranscribingNote(false);
        }
      };
      noteRecorderRef.current = recorder;
      recorder.start();
      setDictating(true);
    } catch {
      toast.error("Could not access the microphone");
    }
  }, [persistNotes]);

  const stopDictation = useCallback(() => {
    const recorder = noteRecorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
    noteRecorderRef.current = null;
    setDictating(false);
  }, []);

  // ---------------------------------------------------------------------
  // Uploading documents
  // ---------------------------------------------------------------------

  const handleFiles = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not signed in");
      const contextId = await ensureContext();

      for (const file of Array.from(files)) {
        if (!isSupportedDocument(file)) {
          toast.error(`${file.name}: only PDFs and images can be read`);
          continue;
        }
        if (file.size > MAX_FILE_BYTES) {
          toast.error(`${file.name} is too large (25MB maximum)`);
          continue;
        }

        // Read it here. A document with a text layer never leaves the device
        // as an image, and only scanned pages need uploading at all.
        const extracted = await extractDocument(file);
        if (extracted.method === "none") {
          toast.error(`${file.name} could not be read`);
          continue;
        }

        const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        let storedPath = "";
        let contentType = file.type;

        if (extracted.method === "ocr") {
          // Upload the rendered pages for the vision model to read. The first
          // is stored as the document's own path; further pages become their
          // own rows so each is read in order.
          for (let i = 0; i < extracted.pageImages.length; i++) {
            const page = extracted.pageImages[i];
            const path = `${user.id}/${contextId}/${stamp}-p${String(i + 1).padStart(3, "0")}.jpg`;
            const { error } = await supabase.storage
              .from("context-documents")
              .upload(path, page, { contentType: "image/jpeg" });
            if (error) throw new Error(error.message);
            await supabase.from("context_documents").insert({
              context_id: contextId,
              user_id: user.id,
              file_path: path,
              file_name: extracted.pageImages.length > 1
                ? `${file.name} (page ${i + 1})`
                : file.name,
              content_type: "image/jpeg",
              byte_size: page.size,
              extraction_method: "ocr",
              page_count: 1,
            });
          }
        } else {
          storedPath = `${user.id}/${contextId}/${stamp}.pdf`;
          contentType = file.type || "application/pdf";
          const { error } = await supabase.storage
            .from("context-documents")
            .upload(storedPath, file, { contentType });
          if (error) throw new Error(error.message);
          await supabase.from("context_documents").insert({
            context_id: contextId,
            user_id: user.id,
            file_path: storedPath,
            file_name: file.name,
            content_type: contentType,
            byte_size: file.size,
            extracted_text: extracted.text,
            extraction_method: "text-layer",
            page_count: extracted.pageCount,
          });
        }

        setDocuments((prev) => [...prev, {
          id: stamp,
          fileName: file.name,
          pageCount: extracted.pageCount,
          method: extracted.method,
        }]);

        if (extracted.pageCount >= MAX_PAGES) {
          toast.warning(`${file.name}: only the first ${MAX_PAGES} pages were read`);
        }
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }, [ensureContext]);

  const summarise = useCallback(async () => {
    const contextId = contextIdRef.current;
    if (!contextId) return;
    setSummarising(true);
    try {
      const { data, error } = await supabase.functions.invoke("summarise-context", {
        body: { context_id: contextId },
      });
      if (error) throw new Error(error.message);
      setSummary((data?.summary || "") as string);
      setUsedOcr(Boolean(data?.used_ocr));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not summarise the documents");
    } finally {
      setSummarising(false);
    }
  }, []);

  const scanned = documents.filter((d) => d.method === "ocr").length;

  return (
    <Card className="rounded-2xl border-border/60">
      <CardHeader className="pb-3">
        <CardTitle className="font-heading text-sm flex items-center gap-2">
          <FileText className="h-4 w-4" />
          Consultation context
          <span className="ml-auto text-xs font-normal text-muted-foreground">Optional</span>
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Background for your own reference before the consultation. It is not used to
          write the letter.
        </p>
      </CardHeader>

      <CardContent className="space-y-4">
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="text-xs font-medium text-muted-foreground">Notes</label>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 text-xs"
              onClick={dictating ? stopDictation : startDictation}
              disabled={disabled || transcribingNote}
            >
              {transcribingNote ? (
                <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Transcribing…</>
              ) : dictating ? (
                <><Square className="h-3.5 w-3.5 fill-current text-red-600" /> Stop</>
              ) : (
                <><Mic className="h-3.5 w-3.5" /> Dictate</>
              )}
            </Button>
          </div>
          <Textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            onBlur={() => void persistNotes(notes)}
            placeholder="Anything you want to hand to yourself before this consultation — the reason for referral, what you want to cover, questions to ask."
            rows={3}
            className="text-sm resize-y"
            disabled={disabled}
          />
        </div>

        <div>
          <label className="text-xs font-medium text-muted-foreground">
            Supporting documents
          </label>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="application/pdf,image/*"
            className="hidden"
            onChange={(e) => void handleFiles(e.target.files)}
          />
          <div className="mt-1.5 flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-2"
              onClick={() => fileInputRef.current?.click()}
              disabled={disabled || uploading}
            >
              {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Paperclip className="h-4 w-4" />}
              {uploading ? "Reading…" : "Add documents"}
            </Button>
            {documents.length > 0 && (
              <Button
                type="button"
                size="sm"
                className="gap-2"
                onClick={() => void summarise()}
                disabled={disabled || summarising || uploading}
              >
                {summarising ? <Loader2 className="h-4 w-4 animate-spin" /> : <ScanLine className="h-4 w-4" />}
                {summarising ? "Reading documents…" : "Summarise for reference"}
              </Button>
            )}
          </div>

          {documents.length > 0 && (
            <ul className="mt-3 space-y-1.5">
              {documents.map((doc) => (
                <li key={doc.id} className="flex items-center gap-2 text-xs text-muted-foreground">
                  <FileText className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{doc.fileName}</span>
                  <span className="shrink-0 text-[11px] rounded-full border px-1.5 py-0.5">
                    {doc.method === "ocr" ? "scanned" : "text"}
                    {doc.pageCount > 1 && ` · ${doc.pageCount}pp`}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {scanned > 0 && (
            <p className="mt-2 text-xs text-amber-700 dark:text-amber-400 flex gap-1.5">
              <TriangleAlert className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              {scanned === 1 ? "One document is" : `${scanned} documents are`} scanned and
              will be read from the page image. Check anything you intend to rely on
              against the original.
            </p>
          )}
        </div>

        {summary && (
          <div className="rounded-lg border border-border/60 bg-muted/40 p-3">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xs font-medium">Reference summary</span>
              {usedOcr && (
                <span className="text-[11px] text-amber-700 dark:text-amber-400">
                  includes scanned pages
                </span>
              )}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 ml-auto gap-1 text-xs"
                onClick={() => setSummary(null)}
              >
                <Trash2 className="h-3 w-3" /> Hide
              </Button>
            </div>
            <p className="text-xs whitespace-pre-wrap leading-relaxed text-foreground">
              {summary}
            </p>
            <p className="mt-2 text-[11px] text-muted-foreground">
              Generated from the uploaded documents for your reference. It is not used to
              write the letter, and has not been checked against the originals.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
