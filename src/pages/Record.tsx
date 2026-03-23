import { useState, useRef, useCallback, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { Mic, Square, ArrowLeft, Loader2, FileText, RotateCcw } from "lucide-react";
import { Stethoscope } from "lucide-react";

const CHUNK_INTERVAL_MS = 30_000; // 30s chunks — MedASR GPU handles one at a time

// Clean MedASR output — strip model artifacts
function cleanTranscript(text: string): string {
  return text
    .replace(/<\/s>/g, "")
    .replace(/undefined/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const Record = () => {
  const navigate = useNavigate();
  const [isRecording, setIsRecording] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [displayedTranscript, setDisplayedTranscript] = useState("");
  const [fullTranscript, setFullTranscript] = useState("");
  const [transcribing, setTranscribing] = useState(false);
  const [chunksProcessed, setChunksProcessed] = useState(0);
  const [hasStarted, setHasStarted] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);

  // Refs
  const streamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const allChunksRef = useRef<Blob[]>([]); // All recorded blobs for full upload
  const chunkTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);
  const streamQueueRef = useRef<string[]>([]);
  const isStreamingRef = useRef(false);
  const isRecordingRef = useRef(false);

  // Sequential chunk queue for MedASR
  const sendQueueRef = useRef<Blob[]>([]);
  const isSendingRef = useRef(false);

  // Streaming typewriter effect
  const drainStreamQueue = useCallback(() => {
    if (isStreamingRef.current) return;
    if (streamQueueRef.current.length === 0) {
      setIsStreaming(false);
      return;
    }

    isStreamingRef.current = true;
    setIsStreaming(true);

    const text = streamQueueRef.current.shift()!;
    const words = text.split(/(\s+)/);
    let i = 0;

    const tick = () => {
      if (i < words.length) {
        setDisplayedTranscript((prev) => prev + words[i]);
        i++;
        requestAnimationFrame(() => setTimeout(tick, 30 + Math.random() * 30));
      } else {
        isStreamingRef.current = false;
        drainStreamQueue();
      }
    };
    tick();
  }, []);

  // When fullTranscript grows, queue new portion for streaming
  const prevFullRef = useRef("");
  useEffect(() => {
    if (fullTranscript.length > prevFullRef.current.length) {
      const newText = fullTranscript.slice(prevFullRef.current.length);
      prevFullRef.current = fullTranscript;
      streamQueueRef.current.push(newText);
      drainStreamQueue();
    }
  }, [fullTranscript, drainStreamQueue]);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [displayedTranscript]);

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

  // Send one blob to MedASR sequentially
  const processNextInQueue = useCallback(async () => {
    if (isSendingRef.current || sendQueueRef.current.length === 0) return;

    isSendingRef.current = true;
    setTranscribing(true);
    const blob = sendQueueRef.current.shift()!;

    try {
      const formData = new FormData();
      formData.append("audio", blob, "chunk.webm");

      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/transcribe-chunk`,
        {
          method: "POST",
          headers: { apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY },
          body: formData,
        }
      );

      const responseText = await response.text();

      if (!response.ok) {
        console.error("Chunk error:", response.status, responseText);
        toast.error(`Chunk failed (${response.status}): ${responseText.slice(0, 100)}`);
      } else {
        const result = JSON.parse(responseText);
        const cleaned = cleanTranscript(result.text || "");
        if (cleaned) {
          setFullTranscript((prev) => (prev ? prev + " " + cleaned : cleaned));
          setChunksProcessed((c) => c + 1);
        }
      }
    } catch (err) {
      console.error("Failed to transcribe chunk:", err);
    } finally {
      isSendingRef.current = false;
      if (sendQueueRef.current.length > 0) {
        processNextInQueue();
      } else {
        setTranscribing(false);
      }
    }
  }, []);

  // Create a MediaRecorder, collect data, and return blob on stop
  const createRecorderSegment = useCallback((stream: MediaStream): Promise<Blob> => {
    return new Promise((resolve) => {
      const chunks: Blob[] = [];
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";
      const recorder = new MediaRecorder(stream, { mimeType });

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          chunks.push(e.data);
          allChunksRef.current.push(e.data);
        }
      };

      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: mimeType });
        resolve(blob);
      };

      mediaRecorderRef.current = recorder;
      recorder.start(1000); // Collect data every second
    });
  }, []);

  // Cycle: stop current recorder → send blob → start new recorder
  const cycleRecorder = useCallback(async () => {
    if (!isRecordingRef.current || !streamRef.current) return;

    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state !== "recording") return;

    // Stop current segment — promise resolves with the blob
    const blobPromise = new Promise<Blob>((resolve) => {
      const chunks: Blob[] = [];
      const origHandler = recorder.ondataavailable;

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          chunks.push(e.data);
          allChunksRef.current.push(e.data);
        }
      };

      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: recorder.mimeType });
        resolve(blob);
      };

      recorder.stop();
    });

    const blob = await blobPromise;
    console.log("Chunk recorded:", blob.size, "bytes");

    // Queue for transcription
    sendQueueRef.current.push(blob);
    processNextInQueue();

    // Start new segment if still recording
    if (isRecordingRef.current && streamRef.current) {
      createRecorderSegment(streamRef.current);
    }
  }, [processNextInQueue, createRecorderSegment]);

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      // Clear state
      allChunksRef.current = [];
      sendQueueRef.current = [];
      isSendingRef.current = false;

      if (chunkTimerRef.current) clearInterval(chunkTimerRef.current);
      if (timerRef.current) clearInterval(timerRef.current);

      setIsRecording(true);
      isRecordingRef.current = true;
      setHasStarted(true);
      setElapsed(0);
      setFullTranscript("");
      setDisplayedTranscript("");
      prevFullRef.current = "";
      streamQueueRef.current = [];
      isStreamingRef.current = false;
      setChunksProcessed(0);

      // Start first recording segment
      createRecorderSegment(stream);

      // Cycle recorder every 30s to send chunks
      chunkTimerRef.current = setInterval(() => {
        cycleRecorder();
      }, CHUNK_INTERVAL_MS);

      // Timer
      const startTime = Date.now();
      timerRef.current = setInterval(() => {
        setElapsed(Math.floor((Date.now() - startTime) / 1000));
      }, 1000);

      await requestWakeLock();
    } catch {
      toast.error("Microphone access denied");
    }
  }, [createRecorderSegment, cycleRecorder, requestWakeLock]);

  const stopRecording = useCallback(() => {
    setIsRecording(false);
    isRecordingRef.current = false;

    if (chunkTimerRef.current) clearInterval(chunkTimerRef.current);
    if (timerRef.current) clearInterval(timerRef.current);

    // Stop current recorder and send final chunk
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state === "recording") {
      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          chunks.push(e.data);
          allChunksRef.current.push(e.data);
        }
      };
      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: recorder.mimeType });
        if (blob.size > 0) {
          console.log("Final chunk:", blob.size, "bytes");
          sendQueueRef.current.push(blob);
          processNextInQueue();
        }
      };
      recorder.stop();
    }

    streamRef.current?.getTracks().forEach((t) => t.stop());
    releaseWakeLock();
  }, [processNextInQueue, releaseWakeLock]);

  useEffect(() => {
    return () => {
      releaseWakeLock();
      if (chunkTimerRef.current) clearInterval(chunkTimerRef.current);
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [releaseWakeLock]);

  const handleSubmit = async () => {
    if (!fullTranscript.trim()) {
      toast.error("No transcript available yet");
      return;
    }
    setProcessing(true);

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      // Upload full recording as webm
      const fullBlob = new Blob(allChunksRef.current, { type: "audio/webm" });
      const fileName = `${user.id}/${Date.now()}.webm`;
      const { error: uploadError } = await supabase.storage
        .from("audio-recordings")
        .upload(fileName, fullBlob);
      if (uploadError) throw uploadError;

      const { data: recording, error: recError } = await supabase
        .from("recordings")
        .insert({
          user_id: user.id,
          audio_path: fileName,
          status: "transcribed",
          duration_seconds: elapsed,
        })
        .select()
        .single();
      if (recError) throw recError;

      const { data: fnData, error: fnError } = await supabase.functions.invoke("generate-letter", {
        body: { recording_id: recording.id, transcript: fullTranscript },
      });

      if (fnError) throw fnError;

      toast.success("Letter generated successfully!");
      navigate(`/letter/${fnData.letter_id}`);
    } catch (error: any) {
      toast.error(error.message || "Failed to process recording");
      setProcessing(false);
    }
  };

  const handleDiscard = () => {
    setFullTranscript("");
    setDisplayedTranscript("");
    prevFullRef.current = "";
    streamQueueRef.current = [];
    isStreamingRef.current = false;
    setElapsed(0);
    setChunksProcessed(0);
    setHasStarted(false);
    allChunksRef.current = [];
  };

  const formatTime = (s: number) =>
    `${Math.floor(s / 60).toString().padStart(2, "0")}:${(s % 60).toString().padStart(2, "0")}`;

  const hasStopped = !isRecording && hasStarted;

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 dark:from-slate-950 dark:to-slate-900">
      {/* Header */}
      <header className="border-b border-slate-200 dark:border-slate-800 bg-white/80 dark:bg-slate-900/80 backdrop-blur-sm sticky top-0 z-10">
        <div className="container flex h-14 items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => navigate("/dashboard")} className="text-slate-500 hover:text-slate-700">
            <ArrowLeft className="h-4 w-4 mr-1" />
            Dashboard
          </Button>
          <div className="h-4 w-px bg-slate-200 dark:bg-slate-700" />
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary">
              <Stethoscope className="h-4 w-4 text-primary-foreground" />
            </div>
            <h1 className="font-semibold text-sm text-slate-900 dark:text-slate-100">New Recording</h1>
          </div>
          {isRecording && (
            <div className="ml-auto flex items-center gap-2">
              <span className="relative flex h-2.5 w-2.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-red-500" />
              </span>
              <span className="text-xs font-medium text-red-600 dark:text-red-400">Recording</span>
            </div>
          )}
        </div>
      </header>

      {/* Main content */}
      <main className="container py-8">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 max-w-6xl mx-auto">

          {/* Left panel — Recording controls */}
          <div className="lg:col-span-4">
            <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm p-8 sticky top-20">
              <div className="flex flex-col items-center gap-6">
                {/* Status label */}
                <div className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium ${
                  isRecording
                    ? "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-400"
                    : hasStopped
                    ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400"
                    : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400"
                }`}>
                  {isRecording ? "● Recording" : hasStopped ? "✓ Complete" : "Ready"}
                </div>

                {/* Timer */}
                <div className="text-5xl font-mono font-bold tabular-nums text-slate-900 dark:text-slate-100 tracking-tight">
                  {formatTime(elapsed)}
                </div>

                {/* Record / Stop button */}
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

                <p className="text-xs text-slate-500 dark:text-slate-400 text-center">
                  {isRecording
                    ? "Tap to stop recording"
                    : hasStopped
                    ? "Recording finished"
                    : "Tap to start consultation recording"}
                </p>

                {/* Chunk progress */}
                {hasStarted && (
                  <div className="w-full pt-2 border-t border-slate-100 dark:border-slate-800">
                    <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
                      <span>Chunks transcribed</span>
                      <div className="flex items-center gap-1.5">
                        {transcribing && <Loader2 className="h-3 w-3 animate-spin" />}
                        <span className="font-medium text-slate-700 dark:text-slate-300">{chunksProcessed}</span>
                      </div>
                    </div>
                  </div>
                )}

                {/* Actions after stop */}
                {hasStopped && (
                  <div className="w-full space-y-2 pt-2">
                    <Button
                      onClick={handleSubmit}
                      className="w-full gap-2 h-11"
                      disabled={processing || transcribing || isStreaming || !fullTranscript.trim()}
                    >
                      {processing ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Generating Letter...
                        </>
                      ) : transcribing ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Finishing transcription...
                        </>
                      ) : (
                        <>
                          <FileText className="h-4 w-4" />
                          Generate Letter
                        </>
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={handleDiscard}
                      className="w-full gap-2 text-slate-500 hover:text-slate-700"
                      disabled={processing || transcribing}
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                      Discard & Re-record
                    </Button>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Right panel — Live transcript */}
          <div className="lg:col-span-8">
            <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm h-full min-h-[500px] flex flex-col">
              {/* Transcript header */}
              <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 dark:border-slate-800">
                <div className="flex items-center gap-2">
                  <FileText className="h-4 w-4 text-slate-400" />
                  <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Live Transcript</h2>
                </div>
                {transcribing && (
                  <div className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Processing chunk...
                  </div>
                )}
                {!transcribing && !isStreaming && displayedTranscript && (
                  <span className="text-xs text-emerald-600 dark:text-emerald-400 font-medium">Up to date</span>
                )}
              </div>

              {/* Transcript body */}
              <div className="flex-1 overflow-y-auto px-6 py-4">
                {!hasStarted ? (
                  <div className="h-full flex flex-col items-center justify-center text-center gap-3 py-20">
                    <div className="h-12 w-12 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center">
                      <Mic className="h-5 w-5 text-slate-400" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-slate-600 dark:text-slate-400">Ready to transcribe</p>
                      <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">
                        Start recording and your transcript will appear here in real-time
                      </p>
                    </div>
                  </div>
                ) : !displayedTranscript && !transcribing && !isStreaming ? (
                  <div className="h-full flex flex-col items-center justify-center text-center gap-3 py-20">
                    <div className="h-12 w-12 rounded-full bg-amber-50 dark:bg-amber-950 flex items-center justify-center">
                      <Loader2 className="h-5 w-5 text-amber-500 animate-spin" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-slate-600 dark:text-slate-400">Waiting for first chunk...</p>
                      <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">
                        Audio is sent every 30 seconds — first transcript will appear shortly
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="prose prose-sm dark:prose-invert max-w-none">
                    <p className="text-slate-700 dark:text-slate-300 leading-relaxed whitespace-pre-wrap">
                      {displayedTranscript}
                      {(isStreaming || transcribing) && (
                        <span className="inline-block w-0.5 h-4 bg-primary ml-0.5 animate-pulse align-text-bottom" />
                      )}
                    </p>
                    <div ref={transcriptEndRef} />
                  </div>
                )}
              </div>

              {/* Transcript footer */}
              {hasStarted && (
                <div className="px-6 py-3 border-t border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/50 rounded-b-xl">
                  <div className="flex items-center justify-between text-xs text-slate-400">
                    <span>Powered by Google MedASR</span>
                    <span>{displayedTranscript.split(/\s+/).filter(Boolean).length} words</span>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
};

export default Record;
