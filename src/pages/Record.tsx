import { useState, useRef, useCallback, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { Mic, Square, Loader2, FileText, RotateCcw } from "lucide-react";

const Record = () => {
  const navigate = useNavigate();
  const [isRecording, setIsRecording] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [processingStatus, setProcessingStatus] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [hasRecording, setHasRecording] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [interimText, setInterimText] = useState("");

  const streamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const transcriptRef = useRef("");
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll transcript to bottom
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcript, interimText]);

  const requestWakeLock = useCallback(async () => {
    try {
      if ("wakeLock" in navigator) {
        wakeLockRef.current = await navigator.wakeLock.request("screen");
      }
    } catch { /* non-critical */ }
  }, []);

  const releaseWakeLock = useCallback(() => {
    wakeLockRef.current?.release();
    wakeLockRef.current = null;
  }, []);

  const connectDeepgram = useCallback(async (): Promise<WebSocket> => {
    // Get Deepgram API key from our edge function
    const { data, error } = await supabase.functions.invoke("deepgram-token");
    if (error || !data?.key) throw new Error("Failed to get Deepgram token");

    const params = new URLSearchParams({
      model: "nova-2-medical",
      language: "en-GB",
      smart_format: "true",
      punctuate: "true",
      interim_results: "true",
      utterance_end_ms: "1000",
      vad_events: "true",
    });

    const ws = new WebSocket(
      `wss://api.deepgram.com/v1/listen?${params}`,
      ["token", data.key]
    );

    return new Promise((resolve, reject) => {
      ws.onopen = () => {
        console.log("[Deepgram] Connected");
        resolve(ws);
      };

      ws.onerror = (e) => {
        console.error("[Deepgram] Error:", e);
        reject(new Error("Deepgram connection failed"));
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === "Results" && msg.channel?.alternatives?.[0]) {
            const alt = msg.channel.alternatives[0];
            const text = alt.transcript;

            if (!text) return;

            if (msg.is_final) {
              transcriptRef.current += (transcriptRef.current ? " " : "") + text;
              setTranscript(transcriptRef.current);
              setInterimText("");
            } else {
              setInterimText(text);
            }
          }
        } catch (e) {
          console.error("[Deepgram] Parse error:", e);
        }
      };

      ws.onclose = (e) => {
        console.log("[Deepgram] Closed:", e.code, e.reason);
      };
    });
  }, []);

  const startRecording = useCallback(async () => {
    try {
      setTranscript("");
      setInterimText("");
      transcriptRef.current = "";

      // Connect to Deepgram first
      const ws = await connectDeepgram();
      wsRef.current = ws;

      // Get microphone
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];

      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";

      const recorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          chunksRef.current.push(e.data);
          // Stream to Deepgram
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(e.data);
          }
        }
      };

      recorder.onstop = () => {
        setHasRecording(chunksRef.current.length > 0);
      };

      recorder.start(250); // 250ms chunks for low-latency streaming
      setIsRecording(true);
      setElapsed(0);
      setHasRecording(false);

      const startTime = Date.now();
      timerRef.current = setInterval(() => {
        setElapsed(Math.floor((Date.now() - startTime) / 1000));
      }, 1000);

      await requestWakeLock();
    } catch (err: any) {
      toast.error(err.message || "Failed to start recording");
      // Clean up Deepgram if mic fails
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    }
  }, [connectDeepgram, requestWakeLock]);

  const stopRecording = useCallback(() => {
    setIsRecording(false);
    if (timerRef.current) clearInterval(timerRef.current);

    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state === "recording") {
      recorder.stop();
    }

    streamRef.current?.getTracks().forEach((t) => t.stop());

    // Close Deepgram WebSocket gracefully
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "CloseStream" }));
      setTimeout(() => {
        wsRef.current?.close();
        wsRef.current = null;
      }, 500);
    }

    releaseWakeLock();
  }, [releaseWakeLock]);

  useEffect(() => {
    return () => {
      releaseWakeLock();
      if (timerRef.current) clearInterval(timerRef.current);
      wsRef.current?.close();
    };
  }, [releaseWakeLock]);

  const handleSubmit = async () => {
    const finalTranscript = transcriptRef.current;
    if (!finalTranscript && chunksRef.current.length === 0) {
      toast.error("No recording available");
      return;
    }

    setProcessing(true);
    setProcessingStatus("Uploading recording...");

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      // Upload full recording for archival
      const blob = new Blob(chunksRef.current, { type: "audio/webm" });
      const fileName = `${user.id}/${Date.now()}.webm`;
      const { error: uploadError } = await supabase.storage
        .from("audio-recordings")
        .upload(fileName, blob);
      if (uploadError) throw uploadError;

      // Create recording record
      setProcessingStatus("Creating recording...");
      const { data: recording, error: recError } = await supabase
        .from("recordings")
        .insert({
          user_id: user.id,
          audio_path: fileName,
          status: "uploaded",
          duration_seconds: elapsed,
        })
        .select()
        .single();
      if (recError) throw recError;

      // Generate letter — pass transcript directly (skip MedASR)
      setProcessingStatus("Generating clinical letter...");
      const { data: fnData, error: fnError } = await supabase.functions.invoke(
        "generate-letter",
        {
          body: {
            recording_id: recording.id,
            audio_path: fileName,
            transcript: finalTranscript || undefined,
          },
        }
      );

      if (fnError) throw fnError;

      toast.success("Letter generated successfully!");
      navigate(`/letter/${fnData.letter_id}`);
    } catch (error: any) {
      toast.error(error.message || "Failed to process recording");
      setProcessing(false);
      setProcessingStatus("");
    }
  };

  const handleDiscard = () => {
    chunksRef.current = [];
    setElapsed(0);
    setHasRecording(false);
    setTranscript("");
    setInterimText("");
    transcriptRef.current = "";
  };

  const formatTime = (s: number) =>
    `${Math.floor(s / 60).toString().padStart(2, "0")}:${(s % 60).toString().padStart(2, "0")}`;

  const hasStopped = !isRecording && hasRecording;
  const hasTranscript = transcript.length > 0 || interimText.length > 0;

  return (
    <div className="bg-gradient-to-br from-slate-50 to-slate-100 dark:from-slate-950 dark:to-slate-900 min-h-full">
      <div className="p-6">
        <div className="max-w-5xl mx-auto">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Left panel — Recording controls */}
            <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm p-8">
              <div className="flex flex-col items-center gap-6">
                {/* Status label */}
                <div className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium ${
                  processing
                    ? "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-400"
                    : isRecording
                    ? "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-400"
                    : hasStopped
                    ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400"
                    : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400"
                }`}>
                  {processing ? "● Processing" : isRecording ? "● Recording" : hasStopped ? "✓ Complete" : "Ready"}
                </div>

                {/* Timer */}
                <div className="text-5xl font-mono font-bold tabular-nums text-slate-900 dark:text-slate-100 tracking-tight">
                  {formatTime(elapsed)}
                </div>

                {/* Record / Stop button */}
                {!processing && (
                  <div className="relative">
                    {isRecording && (
                      <div className="absolute -inset-3 rounded-full bg-red-500/10 animate-pulse" />
                    )}
                    <button
                      onClick={isRecording ? stopRecording : startRecording}
                      disabled={processing || hasStopped}
                      className={`relative flex h-20 w-20 items-center justify-center rounded-full transition-all shadow-lg ${
                        isRecording
                          ? "bg-red-500 hover:bg-red-600 shadow-red-500/25"
                          : hasStopped
                          ? "bg-slate-300 dark:bg-slate-700 cursor-not-allowed"
                          : "bg-primary hover:bg-primary/90 shadow-primary/25"
                      }`}
                    >
                      {isRecording ? (
                        <Square className="h-7 w-7 text-white" />
                      ) : (
                        <Mic className="h-7 w-7 text-white" />
                      )}
                    </button>
                  </div>
                )}

                {/* Processing spinner */}
                {processing && (
                  <div className="flex flex-col items-center gap-3">
                    <div className="relative">
                      <div className="absolute -inset-3 rounded-full bg-blue-500/10 animate-pulse" />
                      <div className="relative flex h-20 w-20 items-center justify-center rounded-full bg-primary shadow-lg shadow-primary/25">
                        <Loader2 className="h-8 w-8 text-white animate-spin" />
                      </div>
                    </div>
                    <p className="text-sm text-slate-600 dark:text-slate-400 font-medium">
                      {processingStatus}
                    </p>
                  </div>
                )}

                {!processing && (
                  <p className="text-xs text-slate-500 dark:text-slate-400 text-center">
                    {isRecording
                      ? "Tap to stop recording"
                      : hasStopped
                      ? "Recording finished — generate your letter or re-record"
                      : "Tap to start consultation recording"}
                  </p>
                )}

                {/* Actions after stop */}
                {hasStopped && !processing && (
                  <div className="w-full space-y-2 pt-2">
                    <Button
                      onClick={handleSubmit}
                      className="w-full gap-2 h-11"
                    >
                      <FileText className="h-4 w-4" />
                      Generate Letter
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={handleDiscard}
                      className="w-full gap-2 text-slate-500 hover:text-slate-700"
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                      Discard & Re-record
                    </Button>
                  </div>
                )}
              </div>
            </div>

            {/* Right panel — Live transcript */}
            <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm flex flex-col">
              <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  Live Transcript
                </h3>
                {isRecording && (
                  <span className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
                    <span className="relative flex h-2 w-2">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
                    </span>
                    Listening
                  </span>
                )}
              </div>

              <div className="flex-1 min-h-[300px] max-h-[500px] overflow-y-auto p-6">
                {hasTranscript ? (
                  <div className="text-sm leading-relaxed text-slate-700 dark:text-slate-300">
                    {transcript}
                    {interimText && (
                      <span className="text-slate-400 dark:text-slate-500">
                        {transcript ? " " : ""}{interimText}
                      </span>
                    )}
                    <div ref={transcriptEndRef} />
                  </div>
                ) : (
                  <div className="h-full flex items-center justify-center">
                    <p className="text-sm text-slate-400 dark:text-slate-500 text-center">
                      {isRecording
                        ? "Waiting for speech..."
                        : "Transcript will appear here as you speak"}
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Record;
