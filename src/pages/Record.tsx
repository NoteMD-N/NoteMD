import { useState, useRef, useCallback, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { Mic, Square, ArrowLeft, Loader2, FileText, RotateCcw } from "lucide-react";
import { Stethoscope } from "lucide-react";

// Encode raw PCM Float32 samples into a WAV Blob at the given sample rate
function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

const CHUNK_INTERVAL_MS = 15_000;
const TARGET_SAMPLE_RATE = 16_000;

const Record = () => {
  const navigate = useNavigate();
  const [isRecording, setIsRecording] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [transcript, setTranscript] = useState("");
  const [transcribing, setTranscribing] = useState(false);
  const [chunksProcessed, setChunksProcessed] = useState(0);
  const [hasStarted, setHasStarted] = useState(false);

  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const samplesRef = useRef<Float32Array[]>([]);
  const allSamplesRef = useRef<Float32Array[]>([]);
  const chunkTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const pendingChunksRef = useRef(0);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll transcript to bottom
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcript]);

  const requestWakeLock = useCallback(async () => {
    try {
      if ("wakeLock" in navigator) {
        wakeLockRef.current = await navigator.wakeLock.request("screen");
      }
    } catch {
      // non-critical
    }
  }, []);

  const releaseWakeLock = useCallback(() => {
    wakeLockRef.current?.release();
    wakeLockRef.current = null;
  }, []);

  const sendChunk = useCallback(async (samples: Float32Array[]) => {
    if (samples.length === 0) return;

    const totalLength = samples.reduce((sum, s) => sum + s.length, 0);
    const merged = new Float32Array(totalLength);
    let offset = 0;
    for (const s of samples) {
      merged.set(s, offset);
      offset += s.length;
    }

    if (merged.length === 0) return;

    const wavBlob = encodeWav(merged, TARGET_SAMPLE_RATE);

    pendingChunksRef.current++;
    setTranscribing(true);

    try {
      const formData = new FormData();
      formData.append("audio", wavBlob, "chunk.wav");

      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        console.error("No session available for chunk transcription");
        return;
      }

      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/transcribe-chunk`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${session.access_token}`,
          },
          body: formData,
        }
      );

      if (!response.ok) {
        const errText = await response.text();
        console.error("Chunk transcription error:", response.status, errText);
        toast.error("Transcription chunk failed — check console");
        return;
      }

      const result = await response.json();
      if (result.text && result.text.trim()) {
        setTranscript((prev) => (prev ? prev + " " + result.text.trim() : result.text.trim()));
        setChunksProcessed((c) => c + 1);
      }
    } catch (err) {
      console.error("Failed to transcribe chunk:", err);
    } finally {
      pendingChunksRef.current--;
      if (pendingChunksRef.current === 0) {
        setTranscribing(false);
      }
    }
  }, []);

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const audioContext = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
      audioContextRef.current = audioContext;

      const source = audioContext.createMediaStreamSource(stream);
      sourceRef.current = source;

      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;

      samplesRef.current = [];
      allSamplesRef.current = [];

      processor.onaudioprocess = (e) => {
        const input = e.inputBuffer.getChannelData(0);
        const copy = new Float32Array(input);
        samplesRef.current.push(copy);
        allSamplesRef.current.push(copy);
      };

      source.connect(processor);
      processor.connect(audioContext.destination);

      chunkTimerRef.current = setInterval(() => {
        const chunk = samplesRef.current.splice(0);
        sendChunk(chunk);
      }, CHUNK_INTERVAL_MS);

      setIsRecording(true);
      setHasStarted(true);
      setElapsed(0);
      setTranscript("");
      setChunksProcessed(0);
      timerRef.current = setInterval(() => setElapsed((e) => e + 1), 1000);

      await requestWakeLock();
    } catch {
      toast.error("Microphone access denied");
    }
  }, [sendChunk, requestWakeLock]);

  const stopRecording = useCallback(() => {
    setIsRecording(false);

    processorRef.current?.disconnect();
    sourceRef.current?.disconnect();
    audioContextRef.current?.close();
    streamRef.current?.getTracks().forEach((t) => t.stop());

    if (chunkTimerRef.current) clearInterval(chunkTimerRef.current);
    if (timerRef.current) clearInterval(timerRef.current);

    const remaining = samplesRef.current.splice(0);
    if (remaining.length > 0) {
      sendChunk(remaining);
    }

    releaseWakeLock();
  }, [sendChunk, releaseWakeLock]);

  useEffect(() => {
    return () => {
      releaseWakeLock();
      if (chunkTimerRef.current) clearInterval(chunkTimerRef.current);
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [releaseWakeLock]);

  const handleSubmit = async () => {
    if (!transcript.trim()) {
      toast.error("No transcript available yet");
      return;
    }
    setProcessing(true);

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      const totalLength = allSamplesRef.current.reduce((sum, s) => sum + s.length, 0);
      const merged = new Float32Array(totalLength);
      let offset = 0;
      for (const s of allSamplesRef.current) {
        merged.set(s, offset);
        offset += s.length;
      }
      const fullWav = encodeWav(merged, TARGET_SAMPLE_RATE);
      const fileName = `${user.id}/${Date.now()}.wav`;
      const { error: uploadError } = await supabase.storage
        .from("audio-recordings")
        .upload(fileName, fullWav);
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
        body: { recording_id: recording.id, transcript },
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
    setTranscript("");
    setElapsed(0);
    setChunksProcessed(0);
    setHasStarted(false);
    allSamplesRef.current = [];
    samplesRef.current = [];
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
                      disabled={processing || transcribing || !transcript.trim()}
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
                {!transcribing && transcript && (
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
                ) : !transcript && !transcribing ? (
                  <div className="h-full flex flex-col items-center justify-center text-center gap-3 py-20">
                    <div className="h-12 w-12 rounded-full bg-amber-50 dark:bg-amber-950 flex items-center justify-center">
                      <Loader2 className="h-5 w-5 text-amber-500 animate-spin" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-slate-600 dark:text-slate-400">Waiting for first chunk...</p>
                      <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">
                        Audio is sent every 15 seconds — first transcript will appear shortly
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="prose prose-sm dark:prose-invert max-w-none">
                    <p className="text-slate-700 dark:text-slate-300 leading-relaxed whitespace-pre-wrap">
                      {transcript}
                    </p>
                    {transcribing && (
                      <span className="inline-flex gap-1 ml-1">
                        <span className="h-1.5 w-1.5 rounded-full bg-slate-400 animate-bounce" style={{ animationDelay: "0ms" }} />
                        <span className="h-1.5 w-1.5 rounded-full bg-slate-400 animate-bounce" style={{ animationDelay: "150ms" }} />
                        <span className="h-1.5 w-1.5 rounded-full bg-slate-400 animate-bounce" style={{ animationDelay: "300ms" }} />
                      </span>
                    )}
                    <div ref={transcriptEndRef} />
                  </div>
                )}
              </div>

              {/* Transcript footer */}
              {hasStarted && (
                <div className="px-6 py-3 border-t border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/50 rounded-b-xl">
                  <div className="flex items-center justify-between text-xs text-slate-400">
                    <span>Powered by Google MedASR</span>
                    <span>{transcript.split(/\s+/).filter(Boolean).length} words</span>
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
