import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SelectGroup,
  SelectLabel,
} from "@/components/ui/select";
import { toast } from "sonner";
import {
  Mic,
  Square,
  Loader2,
  FileText,
  RotateCcw,
  Pause,
  Play,
  Upload,
  Stethoscope,
  PenLine,
  WifiOff,
  Wifi,
  AlertTriangle,
  ChevronRight,
  ChevronLeft,
  LayoutTemplate,
} from "lucide-react";

type RecordMode = "consultation" | "dictation";
type ConnectionQuality = "good" | "fair" | "poor" | "offline";
type Stage = "record" | "review";

type Template = {
  id: string;
  user_id: string | null;
  name: string;
  description: string | null;
  prompt: string;
  mode: string;
  is_preset: boolean;
  is_default: boolean;
};

const Record = () => {
  const navigate = useNavigate();
  const [mode, setMode] = useState<RecordMode>("consultation");
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [patientName, setPatientName] = useState("");
  const [patientId, setPatientId] = useState("");
  const [stage, setStage] = useState<Stage>("record");
  const [editableTranscript, setEditableTranscript] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [processingStatus, setProcessingStatus] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [hasRecording, setHasRecording] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [interimText, setInterimText] = useState("");
  const [connectionQuality, setConnectionQuality] = useState<ConnectionQuality>("good");
  const [deepgramReady, setDeepgramReady] = useState(false);

  // Fetch templates
  const { data: templates = [] } = useQuery({
    queryKey: ["templates-for-record"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("templates")
        .select("*")
        .order("is_preset", { ascending: false })
        .order("name");
      if (error) throw error;
      return data as Template[];
    },
  });

  const templatesForMode = useMemo(
    () => templates.filter((t) => t.mode === mode),
    [templates, mode]
  );

  const myTemplatesForMode = templatesForMode.filter((t) => !t.is_preset);
  const presetTemplatesForMode = templatesForMode.filter((t) => t.is_preset);

  // Auto-select default template when mode changes
  useEffect(() => {
    if (templates.length === 0) return;
    const userDefault = templates.find(
      (t) => t.mode === mode && !t.is_preset && t.is_default
    );
    if (userDefault) {
      setSelectedTemplateId(userDefault.id);
      return;
    }
    // Otherwise fall back to first preset for this mode
    const firstPreset = templates.find((t) => t.mode === mode && t.is_preset);
    if (firstPreset) setSelectedTemplateId(firstPreset.id);
  }, [mode, templates]);

  const selectedTemplate = templates.find((t) => t.id === selectedTemplateId);

  const streamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const transcriptRef = useRef("");
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);
  const elapsedBeforePauseRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const keepAliveRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const deepgramKeyRef = useRef<string | null>(null);
  const modeRef = useRef<RecordMode>(mode);

  // Keep modeRef in sync for use inside async callbacks
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcript, interimText]);

  // Pre-warm Deepgram token on mount
  useEffect(() => {
    (async () => {
      try {
        const { data, error } = await supabase.functions.invoke("deepgram-token");
        if (!error && data?.key) {
          deepgramKeyRef.current = data.key;
          setDeepgramReady(true);
        }
      } catch (e) {
        console.error("Failed to pre-warm Deepgram token", e);
      }
    })();
  }, []);

  // Connection quality monitor
  useEffect(() => {
    let cancelled = false;

    const checkConnection = async () => {
      if (!navigator.onLine) {
        if (!cancelled) setConnectionQuality("offline");
        return;
      }

      try {
        const start = performance.now();
        await fetch("https://api.deepgram.com/v1/", { method: "HEAD", mode: "no-cors" });
        const rtt = performance.now() - start;
        if (cancelled) return;

        if (rtt < 300) setConnectionQuality("good");
        else if (rtt < 800) setConnectionQuality("fair");
        else setConnectionQuality("poor");
      } catch {
        if (!cancelled) setConnectionQuality("poor");
      }
    };

    checkConnection();
    const interval = setInterval(checkConnection, 15000);

    const onOnline = () => setConnectionQuality("good");
    const onOffline = () => setConnectionQuality("offline");
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);

    return () => {
      cancelled = true;
      clearInterval(interval);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  const requestWakeLock = useCallback(async () => {
    try {
      if ("wakeLock" in navigator) {
        wakeLockRef.current = await navigator.wakeLock.request("screen");
      }
    } catch {
      /* non-critical */
    }
  }, []);

  const releaseWakeLock = useCallback(() => {
    wakeLockRef.current?.release();
    wakeLockRef.current = null;
  }, []);

  const connectDeepgram = useCallback(async (): Promise<WebSocket> => {
    // Use pre-fetched key if available, else fetch now
    let key = deepgramKeyRef.current;
    if (!key) {
      const { data, error } = await supabase.functions.invoke("deepgram-token");
      if (error || !data?.key) throw new Error(error?.message || "Failed to get Deepgram token");
      key = data.key;
      deepgramKeyRef.current = key;
    }

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
      ["token", key!]
    );

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Deepgram connection timed out"));
      }, 10000);

      ws.onopen = () => {
        clearTimeout(timeout);
        console.log("[Deepgram] Connected");
        resolve(ws);
      };

      ws.onerror = (e) => {
        clearTimeout(timeout);
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
    if (isStarting) return;
    setIsStarting(true);

    try {
      setTranscript("");
      setInterimText("");
      transcriptRef.current = "";
      elapsedBeforePauseRef.current = 0;

      // Connect Deepgram and get mic in parallel
      const [ws, stream] = await Promise.all([
        connectDeepgram(),
        navigator.mediaDevices.getUserMedia({ audio: true }),
      ]);
      wsRef.current = ws;
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
          // Only stream to Deepgram when recording (not paused)
          if (ws.readyState === WebSocket.OPEN && recorder.state === "recording") {
            ws.send(e.data);
          }
        }
      };

      recorder.onstop = () => {
        setHasRecording(chunksRef.current.length > 0);
      };

      recorder.start(250);
      setIsRecording(true);
      setIsPaused(false);
      setElapsed(0);
      setHasRecording(false);

      const startTime = Date.now();
      timerRef.current = setInterval(() => {
        setElapsed(
          elapsedBeforePauseRef.current + Math.floor((Date.now() - startTime) / 1000)
        );
      }, 1000);

      // Keepalive ping for Deepgram during pauses (every 5s)
      keepAliveRef.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(JSON.stringify({ type: "KeepAlive" }));
          } catch {
            /* ignore */
          }
        }
      }, 5000);

      await requestWakeLock();
    } catch (err: any) {
      toast.error(err.message || "Failed to start recording");
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    } finally {
      setIsStarting(false);
    }
  }, [connectDeepgram, requestWakeLock, isStarting]);

  const pauseRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state === "recording") {
      recorder.pause();
      setIsPaused(true);
      elapsedBeforePauseRef.current = elapsed;
      if (timerRef.current) clearInterval(timerRef.current);
      // KeepAlive interval continues to prevent Deepgram timeout
    }
  }, [elapsed]);

  const resumeRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state === "paused") {
      try {
        recorder.resume();
        setIsPaused(false);
        const startTime = Date.now();
        if (timerRef.current) clearInterval(timerRef.current);
        timerRef.current = setInterval(() => {
          setElapsed(
            elapsedBeforePauseRef.current +
              Math.floor((Date.now() - startTime) / 1000)
          );
        }, 1000);
      } catch (e) {
        console.error("Failed to resume recording", e);
        toast.error("Could not resume. Please stop and start again.");
      }
    }
  }, []);

  const cleanup = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (keepAliveRef.current) clearInterval(keepAliveRef.current);
    timerRef.current = null;
    keepAliveRef.current = null;

    const recorder = mediaRecorderRef.current;
    if (recorder && (recorder.state === "recording" || recorder.state === "paused")) {
      try {
        recorder.stop();
      } catch {
        /* ignore */
      }
    }

    streamRef.current?.getTracks().forEach((t) => t.stop());

    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      try {
        wsRef.current.send(JSON.stringify({ type: "CloseStream" }));
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        wsRef.current?.close();
        wsRef.current = null;
      }, 500);
    }
  }, []);

  const stopRecording = useCallback(() => {
    setIsRecording(false);
    setIsPaused(false);
    cleanup();
    releaseWakeLock();
  }, [cleanup, releaseWakeLock]);

  useEffect(() => {
    return () => {
      releaseWakeLock();
      cleanup();
    };
  }, [releaseWakeLock, cleanup]);

  const processAudio = async (audioBlob: Blob, audioTranscript?: string) => {
    setProcessing(true);
    setProcessingStatus("Preparing recording...");

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      const ext = audioBlob.type.includes("webm") ? "webm" : "wav";
      const fileName = `${user.id}/${Date.now()}.${ext}`;

      // Create recording row first so we have an ID
      setProcessingStatus("Creating recording...");
      const { data: recording, error: recError } = await supabase
        .from("recordings")
        .insert({
          user_id: user.id,
          audio_path: fileName,
          status: "processing",
          duration_seconds: elapsed,
          patient_name: patientName || null,
          patient_id: patientId || null,
          mode: modeRef.current,
          template_id: selectedTemplateId,
        })
        .select()
        .single();
      if (recError) throw recError;

      // Kick off audio upload in background (non-blocking)
      const uploadPromise = supabase.storage
        .from("audio-recordings")
        .upload(fileName, audioBlob)
        .then(({ error }) => {
          if (error) console.error("Background upload failed:", error);
        });

      // If we have a transcript AND we're in consultation mode, generate letter immediately
      // For dictation mode, we need MedASR re-transcribe which requires audio in storage first
      const needsAudioUpload = !audioTranscript || modeRef.current === "dictation";

      if (needsAudioUpload) {
        setProcessingStatus("Uploading audio...");
        await uploadPromise;
      }

      setProcessingStatus("Generating clinical letter...");
      const { data: fnData, error: fnError } = await supabase.functions.invoke(
        "generate-letter",
        {
          body: {
            recording_id: recording.id,
            audio_path: fileName,
            transcript: audioTranscript || undefined,
            mode: modeRef.current,
            patient_name: patientName || undefined,
            patient_id: patientId || undefined,
            template_id: selectedTemplateId || undefined,
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

  // Move from record stage to review stage (where user can edit transcript)
  const goToReview = () => {
    const finalTranscript = transcriptRef.current;
    if (!finalTranscript && chunksRef.current.length === 0) {
      toast.error("No recording available");
      return;
    }
    setEditableTranscript(finalTranscript);
    setStage("review");
  };

  // Actually generate letter from review stage
  const handleGenerateFromReview = async () => {
    const blob = new Blob(chunksRef.current, { type: "audio/webm" });
    // For dictation mode, server will re-transcribe with MedASR regardless; we still send the edited
    // transcript as a fallback. For consultation, we use the edited transcript directly.
    await processAudio(blob, editableTranscript || undefined);
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const validExts = ["webm", "wav", "mp3", "m4a", "ogg", "mp4", "mpeg"];
    const ext = file.name.split(".").pop()?.toLowerCase() || "";
    if (!validExts.includes(ext)) {
      toast.error("Unsupported audio format. Please use WAV, MP3, M4A, or WebM.");
      return;
    }

    await processAudio(file);
    if (fileInputRef.current) fileInputRef.current.value = "";
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
  const canToggleMode = !isRecording && !hasStopped && !processing;
  const canEditPatient = !isRecording && !processing;

  const connectionMeta = {
    good: {
      icon: <Wifi className="h-3.5 w-3.5" />,
      label: "Good connection",
      colour: "text-emerald-600 bg-emerald-50 dark:bg-emerald-950 dark:text-emerald-400",
    },
    fair: {
      icon: <Wifi className="h-3.5 w-3.5" />,
      label: "Fair connection",
      colour: "text-amber-600 bg-amber-50 dark:bg-amber-950 dark:text-amber-400",
    },
    poor: {
      icon: <AlertTriangle className="h-3.5 w-3.5" />,
      label: "Poor connection — live transcript may lag",
      colour: "text-orange-600 bg-orange-50 dark:bg-orange-950 dark:text-orange-400",
    },
    offline: {
      icon: <WifiOff className="h-3.5 w-3.5" />,
      label: "Offline — cannot record",
      colour: "text-red-600 bg-red-50 dark:bg-red-950 dark:text-red-400",
    },
  }[connectionQuality];

  return (
    <div className="bg-gradient-to-br from-slate-50 to-slate-100 dark:from-slate-950 dark:to-slate-900 min-h-full">
      <div className="p-6">
        <div className="max-w-5xl mx-auto space-y-4">
          {/* Top bar: mode toggle + connection status */}
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2">
              <button
                onClick={() => canToggleMode && setMode("consultation")}
                disabled={!canToggleMode}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                  mode === "consultation"
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800"
                } ${!canToggleMode ? "opacity-50 cursor-not-allowed" : ""}`}
              >
                <Stethoscope className="h-4 w-4" />
                Consultation
              </button>
              <button
                onClick={() => canToggleMode && setMode("dictation")}
                disabled={!canToggleMode}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                  mode === "dictation"
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800"
                } ${!canToggleMode ? "opacity-50 cursor-not-allowed" : ""}`}
              >
                <PenLine className="h-4 w-4" />
                Dictation
              </button>
            </div>

            <div className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium ${connectionMeta.colour}`}>
              {connectionMeta.icon}
              {connectionMeta.label}
            </div>
          </div>

          {/* Patient info + template */}
          {stage === "record" && (
            <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm p-4 space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label htmlFor="patientName" className="text-xs font-medium text-slate-600 dark:text-slate-400">
                    Patient Name
                  </Label>
                  <Input
                    id="patientName"
                    value={patientName}
                    onChange={(e) => setPatientName(e.target.value)}
                    placeholder="e.g. John Smith"
                    disabled={!canEditPatient}
                    className="h-9"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="patientId" className="text-xs font-medium text-slate-600 dark:text-slate-400">
                    Patient ID / NHS Number
                  </Label>
                  <Input
                    id="patientId"
                    value={patientId}
                    onChange={(e) => setPatientId(e.target.value)}
                    placeholder="e.g. 123 456 7890"
                    disabled={!canEditPatient}
                    className="h-9"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label className="text-xs font-medium text-slate-600 dark:text-slate-400 flex items-center gap-1.5">
                    <LayoutTemplate className="h-3.5 w-3.5" />
                    Letter Template
                  </Label>
                  <Link
                    to="/templates"
                    className="text-xs text-primary hover:underline"
                  >
                    Manage templates
                  </Link>
                </div>
                <Select
                  value={selectedTemplateId || ""}
                  onValueChange={(v) => setSelectedTemplateId(v)}
                  disabled={!canEditPatient}
                >
                  <SelectTrigger className="h-9">
                    <SelectValue placeholder="Select a template" />
                  </SelectTrigger>
                  <SelectContent>
                    {myTemplatesForMode.length > 0 && (
                      <SelectGroup>
                        <SelectLabel>My Templates</SelectLabel>
                        {myTemplatesForMode.map((t) => (
                          <SelectItem key={t.id} value={t.id}>
                            {t.name}
                            {t.is_default ? " ★" : ""}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    )}
                    {presetTemplatesForMode.length > 0 && (
                      <SelectGroup>
                        <SelectLabel>Presets</SelectLabel>
                        {presetTemplatesForMode.map((t) => (
                          <SelectItem key={t.id} value={t.id}>
                            {t.name}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    )}
                  </SelectContent>
                </Select>
                {selectedTemplate?.description && (
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    {selectedTemplate.description}
                  </p>
                )}
              </div>
            </div>
          )}

          {stage === "record" && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Left panel — Recording controls */}
            <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm p-8">
              <div className="flex flex-col items-center gap-6">
                {/* Status label */}
                <div
                  className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium ${
                    processing
                      ? "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-400"
                      : isStarting
                      ? "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-400"
                      : isPaused
                      ? "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-400"
                      : isRecording
                      ? "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-400"
                      : hasStopped
                      ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400"
                      : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400"
                  }`}
                >
                  {processing
                    ? "● Processing"
                    : isStarting
                    ? "● Connecting..."
                    : isPaused
                    ? "❚❚ Paused"
                    : isRecording
                    ? "● Recording"
                    : hasStopped
                    ? "✓ Complete"
                    : deepgramReady
                    ? "Ready"
                    : "Loading..."}
                </div>

                {/* Timer */}
                <div className="text-5xl font-mono font-bold tabular-nums text-slate-900 dark:text-slate-100 tracking-tight">
                  {formatTime(elapsed)}
                </div>

                {/* Recording buttons */}
                {!processing && (
                  <div className="flex items-center gap-4">
                    <div className="relative">
                      {isRecording && !isPaused && (
                        <div className="absolute -inset-3 rounded-full bg-red-500/10 animate-pulse" />
                      )}
                      <button
                        onClick={isRecording ? stopRecording : startRecording}
                        disabled={processing || hasStopped || isStarting || connectionQuality === "offline"}
                        className={`relative flex h-20 w-20 items-center justify-center rounded-full transition-all shadow-lg ${
                          isRecording
                            ? "bg-red-500 hover:bg-red-600 shadow-red-500/25"
                            : hasStopped || connectionQuality === "offline"
                            ? "bg-slate-300 dark:bg-slate-700 cursor-not-allowed"
                            : "bg-primary hover:bg-primary/90 shadow-primary/25"
                        }`}
                      >
                        {isStarting ? (
                          <Loader2 className="h-7 w-7 text-white animate-spin" />
                        ) : isRecording ? (
                          <Square className="h-7 w-7 text-white" />
                        ) : (
                          <Mic className="h-7 w-7 text-white" />
                        )}
                      </button>
                    </div>

                    {isRecording && (
                      <button
                        onClick={isPaused ? resumeRecording : pauseRecording}
                        className={`flex h-14 w-14 items-center justify-center rounded-full transition-all shadow-md ${
                          isPaused
                            ? "bg-emerald-500 hover:bg-emerald-600 shadow-emerald-500/25"
                            : "bg-amber-500 hover:bg-amber-600 shadow-amber-500/25"
                        }`}
                      >
                        {isPaused ? (
                          <Play className="h-5 w-5 text-white ml-0.5" />
                        ) : (
                          <Pause className="h-5 w-5 text-white" />
                        )}
                      </button>
                    )}
                  </div>
                )}

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
                    {isStarting
                      ? "Connecting to transcription service..."
                      : isPaused
                      ? "Recording paused — tap play to resume"
                      : isRecording
                      ? "Tap stop to finish, or pause to take a break"
                      : hasStopped
                      ? "Recording finished — generate your letter or re-record"
                      : connectionQuality === "offline"
                      ? "You are offline. Reconnect to start recording."
                      : connectionQuality === "poor"
                      ? "Weak connection — recording may be slow to start"
                      : mode === "consultation"
                      ? "Record a consultation or upload an audio file"
                      : "Dictate your clinical notes or upload an audio file"}
                  </p>
                )}

                {hasStopped && !processing && (
                  <div className="w-full space-y-2 pt-2">
                    <Button onClick={goToReview} className="w-full gap-2 h-11">
                      Review Transcript
                      <ChevronRight className="h-4 w-4" />
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

                {!isRecording && !hasStopped && !processing && (
                  <div className="w-full pt-2 border-t border-slate-200 dark:border-slate-800">
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="audio/*"
                      onChange={handleFileUpload}
                      className="hidden"
                    />
                    <Button
                      variant="outline"
                      onClick={() => fileInputRef.current?.click()}
                      className="w-full gap-2 text-slate-600 dark:text-slate-400"
                    >
                      <Upload className="h-4 w-4" />
                      Upload Audio File
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
                {isRecording && !isPaused && (
                  <span className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
                    <span className="relative flex h-2 w-2">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
                    </span>
                    Listening
                  </span>
                )}
                {isPaused && (
                  <span className="text-xs text-amber-600 dark:text-amber-400 font-medium">
                    Paused
                  </span>
                )}
              </div>

              <div className="flex-1 min-h-[300px] max-h-[500px] overflow-y-auto p-6">
                {hasTranscript ? (
                  <div className="text-sm leading-relaxed text-slate-700 dark:text-slate-300">
                    {transcript}
                    {interimText && (
                      <span className="text-slate-400 dark:text-slate-500">
                        {transcript ? " " : ""}
                        {interimText}
                      </span>
                    )}
                    <div ref={transcriptEndRef} />
                  </div>
                ) : (
                  <div className="h-full flex items-center justify-center">
                    <p className="text-sm text-slate-400 dark:text-slate-500 text-center">
                      {isRecording
                        ? "Waiting for speech..."
                        : mode === "dictation"
                        ? "Dictation mode — MedASR will re-transcribe for highest accuracy"
                        : "Transcript will appear here as you speak"}
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>
          )}

          {/* Review stage */}
          {stage === "review" && (
            <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm">
              <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-4 flex-wrap">
                <div>
                  <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                    Review Transcript
                  </h3>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                    Fix typos, correct misheard medications, or clean up the transcript before the
                    AI writes your letter.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    onClick={() => setStage("record")}
                    disabled={processing}
                    className="gap-2"
                  >
                    <ChevronLeft className="h-4 w-4" />
                    Back
                  </Button>
                  <Button
                    onClick={handleGenerateFromReview}
                    disabled={processing || !editableTranscript.trim()}
                    className="gap-2"
                  >
                    {processing ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <FileText className="h-4 w-4" />
                    )}
                    {processing ? processingStatus || "Generating..." : "Generate Letter"}
                  </Button>
                </div>
              </div>
              <div className="p-6">
                {mode === "dictation" && (
                  <div className="mb-4 px-3 py-2 rounded-md bg-blue-50 dark:bg-blue-950 text-xs text-blue-700 dark:text-blue-400">
                    Note: In dictation mode the audio is re-transcribed with MedASR for accuracy,
                    so edits here are used as a fallback.
                  </div>
                )}
                <Textarea
                  value={editableTranscript}
                  onChange={(e) => setEditableTranscript(e.target.value)}
                  disabled={processing}
                  className="min-h-[400px] text-sm leading-relaxed resize-y"
                  placeholder="Transcript..."
                />
                <div className="flex items-center justify-between mt-3 text-xs text-slate-500">
                  <span>
                    {editableTranscript.trim().split(/\s+/).filter(Boolean).length} words
                  </span>
                  {selectedTemplate && (
                    <span className="flex items-center gap-1.5">
                      <LayoutTemplate className="h-3 w-3" />
                      Using template: <strong>{selectedTemplate.name}</strong>
                    </span>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default Record;
