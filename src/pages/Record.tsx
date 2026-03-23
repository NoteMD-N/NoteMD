import { useState, useRef, useCallback, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import { Mic, Square, ArrowLeft, Loader2 } from "lucide-react";
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
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

const CHUNK_INTERVAL_MS = 15_000; // Send a chunk every 15 seconds
const TARGET_SAMPLE_RATE = 16_000; // MedASR expects 16kHz

const Record = () => {
  const navigate = useNavigate();
  const [isRecording, setIsRecording] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [transcript, setTranscript] = useState("");
  const [transcribing, setTranscribing] = useState(false);

  // Audio capture refs
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const samplesRef = useRef<Float32Array[]>([]);
  const allSamplesRef = useRef<Float32Array[]>([]); // All samples for full recording playback
  const chunkTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const pendingChunksRef = useRef(0);
  const isRecordingRef = useRef(false);

  // Request wake lock to prevent screen from sleeping
  const requestWakeLock = useCallback(async () => {
    try {
      if ("wakeLock" in navigator) {
        wakeLockRef.current = await navigator.wakeLock.request("screen");
      }
    } catch {
      // Wake lock not supported or denied — non-critical
    }
  }, []);

  const releaseWakeLock = useCallback(() => {
    wakeLockRef.current?.release();
    wakeLockRef.current = null;
  }, []);

  // Send accumulated audio chunk to transcribe-chunk edge function
  const sendChunk = useCallback(async (samples: Float32Array[]) => {
    if (samples.length === 0) return;

    // Merge sample buffers into one Float32Array
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
      if (!session) return;

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
        console.error("Chunk transcription error:", errText);
        return;
      }

      const result = await response.json();
      if (result.text) {
        setTranscript((prev) => (prev ? prev + " " + result.text : result.text));
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

      // Create AudioContext at 16kHz for MedASR
      const audioContext = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
      audioContextRef.current = audioContext;

      const source = audioContext.createMediaStreamSource(stream);
      sourceRef.current = source;

      // ScriptProcessor to capture raw PCM samples
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

      // Start chunk timer — send audio to MedASR every 15s
      chunkTimerRef.current = setInterval(() => {
        const chunk = samplesRef.current.splice(0);
        sendChunk(chunk);
      }, CHUNK_INTERVAL_MS);

      setIsRecording(true);
      isRecordingRef.current = true;
      setElapsed(0);
      setTranscript("");
      timerRef.current = setInterval(() => setElapsed((e) => e + 1), 1000);

      await requestWakeLock();
    } catch {
      toast.error("Microphone access denied");
    }
  }, [sendChunk, requestWakeLock]);

  const stopRecording = useCallback(() => {
    setIsRecording(false);
    isRecordingRef.current = false;

    // Stop audio capture
    processorRef.current?.disconnect();
    sourceRef.current?.disconnect();
    audioContextRef.current?.close();
    streamRef.current?.getTracks().forEach((t) => t.stop());

    // Clear timers
    if (chunkTimerRef.current) clearInterval(chunkTimerRef.current);
    if (timerRef.current) clearInterval(timerRef.current);

    // Send any remaining audio
    const remaining = samplesRef.current.splice(0);
    if (remaining.length > 0) {
      sendChunk(remaining);
    }

    releaseWakeLock();
  }, [sendChunk, releaseWakeLock]);

  // Clean up on unmount
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

      // Upload full recording as WAV for archival
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

      // Create recording record
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

      // Generate letter with pre-built transcript (skips MedASR, goes straight to GPT)
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

  const formatTime = (s: number) => `${Math.floor(s / 60).toString().padStart(2, "0")}:${(s % 60).toString().padStart(2, "0")}`;

  const hasStopped = !isRecording && (transcript || transcribing);

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-card">
        <div className="container flex h-16 items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => navigate("/dashboard")}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg gradient-primary">
              <Stethoscope className="h-5 w-5 text-primary-foreground" />
            </div>
            <h1 className="font-heading text-xl font-bold text-foreground">New Recording</h1>
          </div>
        </div>
      </header>

      <main className="container max-w-lg py-12">
        <Card className="shadow-elevated">
          <CardHeader>
            <CardTitle className="font-heading text-center text-lg">Record Consultation</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col items-center gap-6">
            {/* Timer */}
            <div className="font-heading text-5xl font-bold tabular-nums text-foreground">
              {formatTime(elapsed)}
            </div>

            {/* Record button */}
            <div className="relative">
              {isRecording && (
                <div className="absolute inset-0 rounded-full bg-destructive/20 animate-pulse-ring" />
              )}
              <button
                onClick={isRecording ? stopRecording : startRecording}
                disabled={processing}
                className={`relative flex h-20 w-20 items-center justify-center rounded-full transition-colors ${
                  isRecording
                    ? "bg-destructive hover:bg-destructive/90"
                    : "bg-primary hover:bg-primary/90"
                }`}
              >
                {isRecording ? (
                  <Square className="h-8 w-8 text-destructive-foreground" />
                ) : (
                  <Mic className="h-8 w-8 text-primary-foreground" />
                )}
              </button>
            </div>

            <p className="text-sm text-muted-foreground">
              {isRecording ? "Recording... tap to stop" : hasStopped ? "Recording complete" : "Tap to start recording"}
            </p>

            {/* Live transcript */}
            {(transcript || transcribing) && (
              <div className="w-full space-y-2">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-medium text-foreground">Live Transcript</h3>
                  {transcribing && (
                    <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                  )}
                </div>
                <div className="max-h-48 overflow-y-auto rounded-md border border-border bg-muted/50 p-3 text-sm text-foreground">
                  {transcript || (
                    <span className="text-muted-foreground">Transcribing...</span>
                  )}
                </div>
              </div>
            )}

            {/* Actions after recording */}
            {hasStopped && (
              <div className="w-full space-y-4">
                <Button
                  onClick={handleSubmit}
                  className="w-full gap-2"
                  disabled={processing || transcribing}
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
                    "Generate Letter"
                  )}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    setTranscript("");
                    setElapsed(0);
                    allSamplesRef.current = [];
                    samplesRef.current = [];
                  }}
                  className="w-full"
                  disabled={processing || transcribing}
                >
                  Discard & Re-record
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
};

export default Record;
