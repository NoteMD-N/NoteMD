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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
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
  Eye,
  Pencil,
  Sparkles,
} from "lucide-react";

type RecordMode = "consultation" | "dictation";
type ConnectionQuality = "good" | "fair" | "poor" | "offline";
type Stage = "record" | "review";
type StreamHealth = "connected" | "reconnecting" | "disconnected";

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
  const [streamHealth, setStreamHealth] = useState<StreamHealth>("connected");
  const [bufferedSeconds, setBufferedSeconds] = useState(0);
  const [previewOpen, setPreviewOpen] = useState(false);

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
  // WebSocket reconnection state
  const pendingChunksRef = useRef<Blob[]>([]); // chunks captured during disconnect
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastMessageAtRef = useRef<number>(Date.now());
  const healthCheckRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isStoppingRef = useRef(false);
  const scheduleReconnectRef = useRef<() => void>(() => {});
  // Tracks whether the WebSocket dropped during this recording. If true, we'll
  // re-transcribe the full audio with MedASR on stop to guarantee completeness.
  const hadDisconnectRef = useRef(false);

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
        // Ping our own backend to gauge connection quality (provider-neutral)
        await fetch(`${import.meta.env.VITE_SUPABASE_URL || "https://mdunhinhsrdrilxcdbvq.supabase.co"}/auth/v1/health`, {
          method: "HEAD",
          mode: "no-cors",
        });
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

    const onOnline = () => {
      setConnectionQuality("good");
      // If we're recording and the WS is dead, trigger immediate reconnect
      if (mediaRecorderRef.current &&
          (mediaRecorderRef.current.state === "recording" || mediaRecorderRef.current.state === "paused") &&
          (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN)) {
        // Reset attempt counter for fast first retry
        reconnectAttemptRef.current = 0;
        scheduleReconnectRef.current();
      }
    };
    const onOffline = () => {
      setConnectionQuality("offline");
      setStreamHealth("disconnected");
    };
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

  const attachWebSocketHandlers = useCallback((ws: WebSocket) => {
    ws.onmessage = (event) => {
      lastMessageAtRef.current = Date.now();
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "Results" && msg.channel?.alternatives?.[0]) {
          const alt = msg.channel.alternatives[0];
          const text = alt.transcript;
          if (!text) return;

          if (msg.is_final) {
            // Append to whatever is currently on screen so user edits during recording are preserved
            setTranscript((prev) => {
              const next = prev + (prev ? " " : "") + text;
              transcriptRef.current = next;
              return next;
            });
            setInterimText("");
          } else {
            setInterimText(text);
          }
        }
      } catch (e) {
        console.error("[Transcription] Parse error:", e);
      }
    };

    ws.onclose = (e) => {
      console.log("[Transcription] Closed:", e.code, e.reason);
      // Trigger reconnection if we're still actively recording (and not deliberately stopping)
      if (!isStoppingRef.current && mediaRecorderRef.current &&
          (mediaRecorderRef.current.state === "recording" || mediaRecorderRef.current.state === "paused")) {
        scheduleReconnect();
      }
    };

    ws.onerror = (e) => {
      console.error("[Transcription] Error:", e);
    };
  }, []);

  const openWebSocket = useCallback(async (): Promise<WebSocket> => {
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
        console.log("[Transcription] Connected");
        lastMessageAtRef.current = Date.now();
        resolve(ws);
      };

      ws.onerror = (e) => {
        clearTimeout(timeout);
        console.error("[Transcription] Connection error:", e);
        reject(new Error("Deepgram connection failed"));
      };
    });
  }, []);

  const flushPendingChunks = useCallback((ws: WebSocket) => {
    if (pendingChunksRef.current.length === 0) return;
    console.log(`[Transcription] Flushing ${pendingChunksRef.current.length} buffered chunks`);
    for (const chunk of pendingChunksRef.current) {
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(chunk);
        }
      } catch (e) {
        console.error("[Transcription] Failed to send buffered chunk:", e);
      }
    }
    pendingChunksRef.current = [];
    setBufferedSeconds(0);
  }, []);

  const scheduleReconnect = useCallback(() => {
    if (reconnectTimerRef.current) return; // already scheduled
    // Mark that a disconnect happened so we can fall back to MedASR re-transcription on stop
    hadDisconnectRef.current = true;
    setStreamHealth("reconnecting");

    const attempt = reconnectAttemptRef.current;
    // Exponential backoff with cap: 1s, 2s, 4s, 8s, max 10s
    const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
    console.log(`[Transcription] Reconnect attempt ${attempt + 1} in ${delay}ms`);

    reconnectTimerRef.current = setTimeout(async () => {
      reconnectTimerRef.current = null;
      reconnectAttemptRef.current += 1;

      try {
        const ws = await openWebSocket();
        wsRef.current = ws;
        attachWebSocketHandlers(ws);

        // Replay buffered chunks
        flushPendingChunks(ws);

        reconnectAttemptRef.current = 0;
        setStreamHealth("connected");
        toast.success("Transcription resumed");
      } catch (err) {
        console.error("[Transcription] Reconnect failed:", err);
        // Try again
        if (!isStoppingRef.current && mediaRecorderRef.current &&
            (mediaRecorderRef.current.state === "recording" || mediaRecorderRef.current.state === "paused")) {
          scheduleReconnect();
        } else {
          setStreamHealth("disconnected");
        }
      }
    }, delay);
  }, [openWebSocket, attachWebSocketHandlers, flushPendingChunks]);

  // Keep ref in sync so window event listeners can call latest scheduleReconnect
  useEffect(() => {
    scheduleReconnectRef.current = scheduleReconnect;
  }, [scheduleReconnect]);

  const startRecording = useCallback(async () => {
    if (isStarting) return;
    setIsStarting(true);

    try {
      setTranscript("");
      setInterimText("");
      transcriptRef.current = "";
      elapsedBeforePauseRef.current = 0;
      pendingChunksRef.current = [];
      reconnectAttemptRef.current = 0;
      isStoppingRef.current = false;
      hadDisconnectRef.current = false;
      setBufferedSeconds(0);
      setStreamHealth("connected");

      // Connect Deepgram and get mic in parallel
      const [ws, stream] = await Promise.all([
        openWebSocket(),
        navigator.mediaDevices.getUserMedia({ audio: true }),
      ]);
      wsRef.current = ws;
      streamRef.current = stream;
      chunksRef.current = [];
      attachWebSocketHandlers(ws);

      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";

      const recorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data.size === 0) return;
        chunksRef.current.push(e.data);

        // Only stream to Deepgram when actively recording (not paused)
        if (recorder.state !== "recording") return;

        const currentWs = wsRef.current;
        if (currentWs && currentWs.readyState === WebSocket.OPEN) {
          try {
            currentWs.send(e.data);
          } catch (err) {
            console.error("[Transcription] Send failed, buffering:", err);
            pendingChunksRef.current.push(e.data);
            setBufferedSeconds((s) => s + 0.25);
          }
        } else {
          // WebSocket not open — buffer for later replay on reconnect
          pendingChunksRef.current.push(e.data);
          setBufferedSeconds((s) => s + 0.25);
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

      // KeepAlive ping every 5s — keeps Deepgram session alive during silence/pause
      keepAliveRef.current = setInterval(() => {
        const currentWs = wsRef.current;
        if (currentWs && currentWs.readyState === WebSocket.OPEN) {
          try {
            currentWs.send(JSON.stringify({ type: "KeepAlive" }));
          } catch {
            /* ignore */
          }
        }
      }, 5000);

      // Health check every 5s — detect stalled connections that haven't formally closed
      healthCheckRef.current = setInterval(() => {
        if (isStoppingRef.current) return;
        const currentWs = wsRef.current;
        if (!currentWs) return;

        // If socket isn't open OR no message received in last 30s, force reconnect
        const stale = Date.now() - lastMessageAtRef.current > 30000;
        const notOpen = currentWs.readyState !== WebSocket.OPEN;

        if (notOpen || stale) {
          console.warn("[Transcription] Health check failed:", { notOpen, stale, readyState: currentWs.readyState });
          try { currentWs.close(); } catch { /* ignore */ }
          wsRef.current = null;
          if (mediaRecorderRef.current &&
              (mediaRecorderRef.current.state === "recording" || mediaRecorderRef.current.state === "paused")) {
            scheduleReconnect();
          }
        }
      }, 5000);

      await requestWakeLock();
    } catch (err: any) {
      toast.error(err.message || "Failed to start recording");
      if (wsRef.current) {
        try { wsRef.current.close(); } catch { /* ignore */ }
        wsRef.current = null;
      }
    } finally {
      setIsStarting(false);
    }
  }, [openWebSocket, attachWebSocketHandlers, scheduleReconnect, requestWakeLock, isStarting]);

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
    isStoppingRef.current = true;

    if (timerRef.current) clearInterval(timerRef.current);
    if (keepAliveRef.current) clearInterval(keepAliveRef.current);
    if (healthCheckRef.current) clearInterval(healthCheckRef.current);
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    timerRef.current = null;
    keepAliveRef.current = null;
    healthCheckRef.current = null;
    reconnectTimerRef.current = null;

    const recorder = mediaRecorderRef.current;
    if (recorder && (recorder.state === "recording" || recorder.state === "paused")) {
      try {
        recorder.stop();
      } catch {
        /* ignore */
      }
    }

    streamRef.current?.getTracks().forEach((t) => t.stop());

    // Try to flush any final buffered chunks before closing
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        // Drain pending chunks if any
        for (const chunk of pendingChunksRef.current) {
          try { ws.send(chunk); } catch { /* ignore */ }
        }
        pendingChunksRef.current = [];
        ws.send(JSON.stringify({ type: "CloseStream" }));
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        try { wsRef.current?.close(); } catch { /* ignore */ }
        wsRef.current = null;
      }, 500);
    } else if (ws) {
      try { ws.close(); } catch { /* ignore */ }
      wsRef.current = null;
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

    // Always send the on-screen transcript to the server as a fallback. The server decides
    // whether to use it (consultation) or to re-transcribe with the dictation engine.
    // If a disconnect occurred during recording, the user is warned on the review screen.
    const disconnectOccurred = hadDisconnectRef.current;
    const fallbackTranscript = audioTranscript;

    if (disconnectOccurred) {
      setProcessingStatus(
        "Connection drop detected — using what was captured to generate your letter..."
      );
    } else {
      setProcessingStatus("Preparing recording...");
    }

    let realtimeChannel: ReturnType<typeof supabase.channel> | null = null;
    let navigated = false;
    const navigateOnce = (letterId: string) => {
      if (navigated) return;
      navigated = true;
      if (realtimeChannel) {
        supabase.removeChannel(realtimeChannel);
        realtimeChannel = null;
      }
      navigate(`/letter/${letterId}`);
    };

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      const ext = audioBlob.type.includes("webm") ? "webm" : "wav";
      const fileName = `${user.id}/${Date.now()}.${ext}`;

      // Create recording row first so we have an ID
      setProcessingStatus(
        disconnectOccurred
          ? "Saving recording..."
          : "Creating recording..."
      );
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

      // Set up Realtime subscription as a backstop. Even if the fetch response below is dropped
      // (laptop sleep, tab background, network blip), the edge function continues running on the
      // server. When the letter row is inserted in the DB, this listener fires and we navigate.
      realtimeChannel = supabase
        .channel(`letter-${recording.id}`)
        .on(
          "postgres_changes",
          {
            event: "INSERT",
            schema: "public",
            table: "letters",
            filter: `recording_id=eq.${recording.id}`,
          },
          (payload) => {
            const letterId = (payload.new as any)?.id;
            if (letterId) {
              toast.success("Letter ready");
              navigateOnce(letterId);
            }
          }
        )
        .subscribe();

      // Kick off audio upload in background (non-blocking)
      const uploadPromise = supabase.storage
        .from("audio-recordings")
        .upload(fileName, audioBlob)
        .then(({ error }) => {
          if (error) console.error("Background upload failed:", error);
        });

      // We need to await the audio upload when the server is expected to transcribe it:
      // - Dictation mode (server always re-transcribes for accuracy)
      // - Consultation with no live transcript (uploaded files, or full-disconnect)
      const willServerTranscribe =
        modeRef.current === "dictation" || !fallbackTranscript;

      if (willServerTranscribe) {
        setProcessingStatus("Uploading audio...");
        await uploadPromise;
      }

      setProcessingStatus("Generating clinical letter...");

      // Fire the edge function. We don't strictly need the response to navigate (Realtime will
      // fire when the letter is created), but a successful response lets us navigate faster.
      const fnPromise = supabase.functions
        .invoke("generate-letter", {
          body: {
            recording_id: recording.id,
            audio_path: fileName,
            // Always send the on-screen transcript — server uses it for consultation, and as a
            // fallback for dictation if server-side transcription fails.
            transcript: fallbackTranscript || undefined,
            mode: modeRef.current,
            patient_name: patientName || undefined,
            patient_id: patientId || undefined,
            template_id: selectedTemplateId || undefined,
            had_disconnect: disconnectOccurred,
          },
        });

      // Race the function response against the realtime event (whichever arrives first).
      const { data: fnData, error: fnError } = await fnPromise;

      if (fnError) {
        // Don't immediately fail — the server may have completed and Realtime will catch it.
        // But also surface the error after a short grace period in case nothing comes through.
        console.error("Edge function returned error:", fnError);
        setTimeout(() => {
          if (!navigated) {
            toast.error(fnError.message || "Letter generation failed");
            setProcessing(false);
            setProcessingStatus("");
            if (realtimeChannel) {
              supabase.removeChannel(realtimeChannel);
              realtimeChannel = null;
            }
          }
        }, 5000);
        return;
      }

      toast.success("Letter generated successfully!");
      if (fnData?.letter_id) navigateOnce(fnData.letter_id);
    } catch (error: any) {
      toast.error(error.message || "Failed to process recording");
      setProcessing(false);
      setProcessingStatus("");
      if (realtimeChannel) {
        supabase.removeChannel(realtimeChannel);
        realtimeChannel = null;
      }
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
    <div className="">
      <div>
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
                <div className="flex gap-2">
                  <Select
                    value={selectedTemplateId || ""}
                    onValueChange={(v) => setSelectedTemplateId(v)}
                    disabled={!canEditPatient}
                  >
                    <SelectTrigger className="h-9 flex-1">
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
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPreviewOpen(true)}
                    disabled={!selectedTemplate}
                    title="Preview template structure"
                    className="h-9 px-3"
                  >
                    <Eye className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => navigate(`/templates?new=${mode}`)}
                    title={`Create or edit a ${mode} template`}
                    className="h-9 px-3"
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                </div>
                {selectedTemplate?.description && (
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    {selectedTemplate.description}
                  </p>
                )}
                {myTemplatesForMode.length === 0 && (
                  <div className="text-xs text-slate-500 dark:text-slate-400 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 rounded-md p-2 mt-1">
                    None of these suit your style?{" "}
                    <Link to={`/templates?new=${mode}`} className="text-primary hover:underline font-medium">
                      Create your own {mode} template
                    </Link>{" "}
                    or clone a preset to customise.
                  </div>
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
                  <div className="flex flex-col items-center gap-3 w-full">
                    <div className="relative">
                      <div className="absolute -inset-3 rounded-full bg-blue-500/10 animate-pulse" />
                      <div className="relative flex h-20 w-20 items-center justify-center rounded-full bg-primary shadow-lg shadow-primary/25">
                        <Loader2 className="h-8 w-8 text-white animate-spin" />
                      </div>
                    </div>
                    <p className="text-sm text-slate-600 dark:text-slate-400 font-medium text-center">
                      {processingStatus}
                    </p>
                    <div className="text-xs text-slate-500 dark:text-slate-400 bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-900 rounded-md p-2.5 mt-2 w-full">
                      <strong>You can leave this page.</strong> Generation continues in the
                      background — we'll open the letter automatically when it's ready, or you
                      can find it in the Letters tab.
                    </div>
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
                {isRecording && !isPaused && streamHealth === "connected" && (
                  <span className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
                    <span className="relative flex h-2 w-2">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
                    </span>
                    Listening
                  </span>
                )}
                {isRecording && streamHealth === "reconnecting" && (
                  <span className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Reconnecting{bufferedSeconds > 0 ? ` — ${Math.ceil(bufferedSeconds)}s buffered` : "..."}
                  </span>
                )}
                {isRecording && streamHealth === "disconnected" && (
                  <span className="flex items-center gap-1.5 text-xs text-red-600 dark:text-red-400">
                    <WifiOff className="h-3 w-3" />
                    Offline — audio still being captured locally
                  </span>
                )}
                {isPaused && (
                  <span className="text-xs text-amber-600 dark:text-amber-400 font-medium">
                    Paused
                  </span>
                )}
              </div>

              <div className="flex-1 min-h-[300px] max-h-[500px] overflow-y-auto p-4 flex flex-col">
                <Textarea
                  value={transcript}
                  onChange={(e) => {
                    setTranscript(e.target.value);
                    transcriptRef.current = e.target.value;
                  }}
                  placeholder={
                    isRecording
                      ? "Waiting for speech..."
                      : "Transcript will appear here as you speak. You can edit at any time — even while recording."
                  }
                  className="flex-1 min-h-[260px] resize-none border-0 shadow-none focus-visible:ring-0 px-2 text-sm leading-relaxed bg-transparent"
                />
                {interimText && (
                  <div className="px-2 pb-2 text-sm leading-relaxed text-slate-400 dark:text-slate-500 italic border-t border-slate-100 dark:border-slate-800 pt-2 mt-1">
                    <span className="text-xs uppercase tracking-wide font-medium mr-2">
                      Hearing now:
                    </span>
                    {interimText}
                  </div>
                )}
                {isRecording && transcript && (
                  <div className="px-2 pt-2 text-xs text-slate-500 dark:text-slate-400 border-t border-slate-100 dark:border-slate-800 mt-1">
                    Tip: you can edit the text above any time — new words will append at the end.
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
                {hadDisconnectRef.current && (
                  <div className="mb-4 px-3 py-2 rounded-md bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-900 text-xs text-amber-800 dark:text-amber-300 flex gap-2">
                    <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                    <div>
                      <strong>Connection dropped during recording.</strong> Please check the
                      transcript below carefully — there may be missing detail near the dropout.
                      Edit anything you need to add before clicking Generate.
                    </div>
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

      {/* Template preview dialog */}
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 flex-wrap">
              {selectedTemplate?.name}
              {selectedTemplate?.is_preset && (
                <Badge variant="outline" className="text-xs">Preset</Badge>
              )}
              {selectedTemplate?.is_default && (
                <Badge className="bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/20 text-xs">
                  Default
                </Badge>
              )}
            </DialogTitle>
            {selectedTemplate?.description && (
              <DialogDescription>{selectedTemplate.description}</DialogDescription>
            )}
          </DialogHeader>

          <div className="space-y-3">
            <div className="text-xs font-medium text-slate-600 dark:text-slate-400 flex items-center gap-1.5">
              <FileText className="h-3.5 w-3.5" />
              This is the prompt the AI will use to format your letter:
            </div>
            <pre className="text-xs whitespace-pre-wrap leading-relaxed p-4 bg-slate-50 dark:bg-slate-950 rounded-lg border border-slate-200 dark:border-slate-800 max-h-[50vh] overflow-y-auto font-mono">
              {selectedTemplate?.prompt}
            </pre>
            <div className="text-xs text-slate-500 dark:text-slate-400 bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-900 rounded-md p-3 flex gap-2">
              <Sparkles className="h-3.5 w-3.5 mt-0.5 shrink-0 text-blue-600 dark:text-blue-400" />
              <div>
                <strong>AI scope:</strong> The AI assists with formatting, structure, summarisation,
                and grammar only. It will not provide medical advice or invent clinical details.
              </div>
            </div>
          </div>

          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="outline" onClick={() => setPreviewOpen(false)}>
              Close
            </Button>
            <Button
              onClick={() => {
                setPreviewOpen(false);
                navigate("/templates");
              }}
              className="gap-2"
            >
              <Pencil className="h-4 w-4" />
              {selectedTemplate?.is_preset ? "Clone & Edit" : "Edit Template"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default Record;
