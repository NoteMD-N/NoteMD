import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { readPhi, writePhi, clearPhi, isSnapshotFresh } from "@/lib/local-phi";
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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
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
  Mail,
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
  // For accurate dictation we transcribe the finished audio with MedASR after
  // Stop rather than streaming a Deepgram draft that later gets replaced.
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [transcribeError, setTranscribeError] = useState<string | null>(null);

  // Fetch templates
  const { data: templates = [] } = useQuery({
    queryKey: ["templates-for-record"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("templates")
        .select("*")
        .order("is_preset", { ascending: false })
        .order("sort_order", { ascending: true })
        .order("name");
      if (error) throw error;
      return data as Template[];
    },
  });

  // Fetch the user's dictation preferences. Every return path yields the same
  // shape so a partially-populated object can't silently change which engine
  // is selected.
  type DictationPrefs = {
    skip_dictation_review: boolean;
    dictation_engine: "fast" | "accurate";
  };
  const DEFAULT_PREFS: DictationPrefs = {
    skip_dictation_review: false,
    dictation_engine: "accurate",
  };
  const { data: userPref } = useQuery<DictationPrefs>({
    queryKey: ["user-record-pref"],
    queryFn: async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return DEFAULT_PREFS;
      const { data } = await supabase
        .from("profiles")
        .select("skip_dictation_review, dictation_engine")
        .eq("user_id", user.id)
        .maybeSingle();
      const engine = (data as any)?.dictation_engine;
      return {
        skip_dictation_review: !!(data as any)?.skip_dictation_review,
        dictation_engine: engine === "fast" || engine === "accurate" ? engine : "accurate",
      };
    },
  });
  const skipDictationReview = userPref?.skip_dictation_review ?? DEFAULT_PREFS.skip_dictation_review;
  const dictationEngine = userPref?.dictation_engine ?? DEFAULT_PREFS.dictation_engine;

  // Persist the dictation engine right from the Record page — the previous UX
  // forced users to jump into Settings to change it. The mutation invalidates
  // the same "user-record-pref" query so the local `dictationEngine` value
  // reflects the change immediately.
  const queryClient = useQueryClient();
  const dictationEngineMutation = useMutation({
    mutationFn: async (engine: "fast" | "accurate") => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");
      const { error } = await supabase
        .from("profiles")
        .update({ dictation_engine: engine } as any)
        .eq("user_id", user.id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["user-record-pref"] });
    },
    onError: (err: any) => {
      toast.error(err.message || "Couldn't save dictation preference");
    },
  });

  // When the user has picked the accurate medical engine for dictation, we skip
  // the live streaming provider entirely and transcribe the finished audio with
  // MedASR after Stop. This gives ONE transcript (from the same engine that
  // powers letter generation) rather than a Deepgram draft that gets replaced.
  const useMedicalDictation = mode === "dictation" && dictationEngine === "accurate";

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
  // Mirror of useMedicalDictation for use inside stable event handlers whose
  // effects only run once (window online listener, etc).
  const useMedicalDictationRef = useRef(false);
  // When accurate dictation uploads the finished audio to transcribe-audio, we
  // remember the storage path so processAudio can reuse it instead of uploading
  // the same blob a second time when the user hits Generate.
  const medicalUploadPathRef = useRef<string | null>(null);
  // For accurate dictation: a second MediaRecorder that emits self-contained
  // ~10s webm segments. Each segment gets uploaded and transcribed with MedASR
  // and the result is appended to the on-screen transcript — so the user sees
  // the MedASR transcript growing live instead of waiting until Stop.
  const segmentRecorderRef = useRef<MediaRecorder | null>(null);
  const segmentChunksRef = useRef<Blob[]>([]);
  const segmentTickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const segmentInFlightRef = useRef(0);
  // WebSocket reconnection state
  const pendingChunksRef = useRef<Blob[]>([]); // chunks captured during disconnect
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastMessageAtRef = useRef<number>(Date.now());
  const healthCheckRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isStoppingRef = useRef(false);
  // Soft-pause flag — when true, audio chunks still arrive from MediaRecorder but
  // are not forwarded to the streaming transcription service. Far more reliable
  // than MediaRecorder.pause()/resume() which silently fails on some browsers.
  const isPausedRef = useRef(false);
  const scheduleReconnectRef = useRef<() => void>(() => {});
  // Tracks whether the WebSocket dropped during this recording. If true, we'll
  // re-transcribe the full audio with MedASR on stop to guarantee completeness.
  const hadDisconnectRef = useRef(false);

  // localStorage session recovery. The audio blob is too large to fit
  // reliably in localStorage, but the transcript + patient meta are cheap.
  // Saved every few seconds while recording so if the tab is closed, the
  // user is offered to recover their in-progress transcript on next open.
  // Slot name within the per-user PHI namespace (see src/lib/local-phi.ts).
  const RECOVERY_SLOT = "recording-recovery";
  type RecoverySnapshot = {
    savedAt: number;
    startedAt: number;
    mode: RecordMode;
    patient_name: string;
    patient_id: string;
    template_id: string | null;
    transcript: string;
    elapsed: number;
  };
  const recoverySaveThrottleRef = useRef<number>(0);
  // Signed-in user id, used to namespace the locally-cached snapshot.
  const recoveryUserIdRef = useRef<string | null>(null);
  const [recovery, setRecovery] = useState<RecoverySnapshot | null>(null);
  // Server-side autosave state: once we create a draft row on Supabase we
  // remember its id so subsequent autosaves update the same row, and normal
  // finish (letter generated) or explicit Discard can consume/replace it.
  const autoDraftRecordingIdRef = useRef<string | null>(null);
  const autoDraftLetterIdRef = useRef<string | null>(null);
  const autoDraftSaveThrottleRef = useRef<number>(0);
  const autoDraftInFlightRef = useRef(false);

  // Keep modeRef in sync for use inside async callbacks
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    useMedicalDictationRef.current = useMedicalDictation;
  }, [useMedicalDictation]);

  // On mount, look for a leftover recovery snapshot from an accidentally-closed
  // session (browser Back, tab closed, crash). Only surface it if it's from the
  // last 24h — anything older is likely stale.
  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      recoveryUserIdRef.current = user.id;

      const snap = readPhi<RecoverySnapshot>(user.id, RECOVERY_SLOT);
      if (!snap?.transcript) return;
      if (!isSnapshotFresh(snap.savedAt)) {
        clearPhi(user.id, RECOVERY_SLOT);
        return;
      }
      setRecovery(snap);
    })();
  }, []);

  // While recording, snapshot the transcript + patient meta every ~3s. Never
  // stores the audio blob (too large for localStorage).
  useEffect(() => {
    if (!isRecording) return;
    const iv = setInterval(() => {
      const now = Date.now();
      if (now - recoverySaveThrottleRef.current < 2500) return;
      recoverySaveThrottleRef.current = now;
      const snap: RecoverySnapshot = {
        savedAt: now,
        startedAt: recoverySaveThrottleRef.current || now,
        mode,
        patient_name: patientName,
        patient_id: patientId,
        template_id: selectedTemplateId,
        transcript: transcriptRef.current || "",
        elapsed,
      };
      // Scoped to the signed-in user so one clinician can never recover
      // another's snapshot from a shared workstation.
      if (recoveryUserIdRef.current) {
        writePhi(recoveryUserIdRef.current, RECOVERY_SLOT, snap);
      }
      // Also mirror to Supabase every ~15s so the interrupted session shows up
      // in the Recordings list quickly — Mohamed reported losing sessions when
      // the browser back button was pressed within the first minute.
      if (transcriptRef.current && now - autoDraftSaveThrottleRef.current >= 15_000) {
        autoDraftSaveThrottleRef.current = now;
        void autosaveDraftToServer();
      }
    }, 3000);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRecording, mode, patientName, patientId, selectedTemplateId, elapsed]);

  // Autosave the in-progress transcript as a draft recording+letter on Supabase.
  // Idempotent: the first successful call creates the rows; subsequent calls
  // update them. Audio isn't uploaded until Discard (with audio) or a normal
  // finish (which uploads and consumes the draft).
  const autosaveDraftToServer = useCallback(async () => {
    if (autoDraftInFlightRef.current) return;
    const transcriptToSave = (transcriptRef.current || "").trim();
    if (!transcriptToSave) return;
    autoDraftInFlightRef.current = true;
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      if (!autoDraftRecordingIdRef.current) {
        const { data: rec, error: recErr } = await supabase
          .from("recordings")
          .insert({
            user_id: user.id,
            audio_path: "",
            status: "draft",
            duration_seconds: elapsed,
            patient_name: patientName || null,
            patient_id: patientId || null,
            mode: modeRef.current,
            template_id: selectedTemplateId,
          })
          .select()
          .single();
        if (recErr || !rec) return;
        autoDraftRecordingIdRef.current = rec.id;

        const { data: letterRow, error: letterErr } = await supabase
          .from("letters")
          .insert({
            recording_id: rec.id,
            user_id: user.id,
            transcript: transcriptToSave,
            letter_content: null,
            status: "draft",
            patient_name: patientName || null,
            patient_id: patientId || null,
            template_id: selectedTemplateId || null,
          })
          .select()
          .single();
        if (!letterErr && letterRow) autoDraftLetterIdRef.current = letterRow.id;
      } else {
        await supabase
          .from("recordings")
          .update({
            duration_seconds: elapsed,
            patient_name: patientName || null,
            patient_id: patientId || null,
            mode: modeRef.current,
            template_id: selectedTemplateId,
          })
          .eq("id", autoDraftRecordingIdRef.current);

        if (autoDraftLetterIdRef.current) {
          await supabase
            .from("letters")
            .update({
              transcript: transcriptToSave,
              patient_name: patientName || null,
              patient_id: patientId || null,
              template_id: selectedTemplateId || null,
            })
            .eq("id", autoDraftLetterIdRef.current);
        }
      }
    } catch (e) {
      console.warn("[record] autosaveDraftToServer failed:", e);
    } finally {
      autoDraftInFlightRef.current = false;
    }
  }, [elapsed, patientName, patientId, selectedTemplateId]);

  // On explicit Discard or successful letter generation the auto-draft is
  // either consumed (Discard adds the audio to it) or removed (letter created).
  const deleteAutoDraft = useCallback(async () => {
    const recId = autoDraftRecordingIdRef.current;
    if (!recId) return;
    autoDraftRecordingIdRef.current = null;
    autoDraftLetterIdRef.current = null;
    try {
      await supabase.from("recordings").delete().eq("id", recId);
    } catch {/* ignore */}
  }, []);

  // Clear the recovery snapshot once the session is finished in the normal way
  // (letter generated, or explicitly discarded — see handleDiscard).
  const clearRecovery = useCallback(() => {
    if (recoveryUserIdRef.current) {
      clearPhi(recoveryUserIdRef.current, RECOVERY_SLOT);
    }
    setRecovery(null);
  }, []);

  // Catch accidental navigation away (browser back, tab close, refresh)
  // while the user has unsaved work. We fire a best-effort autosave to
  // Supabase so the draft appears in Recordings, and — for the tab-close
  // case — show a native "Leave site?" prompt so the user has a chance
  // to reconsider.
  useEffect(() => {
    const hasUnsavedWork = () =>
      isRecording || (!!transcriptRef.current && !autoDraftRecordingIdRef.current);

    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!hasUnsavedWork()) return;
      // Fire-and-forget final autosave; browsers may not wait for it to
      // finish, but a Supabase POST is short and often lands.
      void autosaveDraftToServer();
      e.preventDefault();
      // Legacy compat — returning a string used to customise the prompt.
      // Modern browsers show a generic message but still respect preventDefault.
      e.returnValue = "";
      return "";
    };

    // pagehide fires even when beforeunload doesn't (e.g. on iOS Safari).
    // Same fire-and-forget autosave; no prompt because we can't show one here.
    const onPageHide = () => {
      if (hasUnsavedWork()) void autosaveDraftToServer();
    };

    // Backgrounding the tab often precedes it being killed — save then too.
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden" && hasUnsavedWork()) {
        void autosaveDraftToServer();
      }
    };

    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener("pagehide", onPageHide);
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("visibilitychange", onVisibilityChange);

      // React Router back/forward → the component unmounts but the tab
      // stays open. Fire a final autosave on unmount so the in-progress
      // session lands in Recordings.
      if (transcriptRef.current || isRecording) {
        void autosaveDraftToServer();
      }
    };
  }, [isRecording, autosaveDraftToServer]);

  // Applies a recovered snapshot to the current form so the user can save it as
  // a draft or generate a letter from the recovered transcript. Audio isn't
  // available so we go straight to the review stage.
  const restoreRecovery = useCallback((snap: RecoverySnapshot) => {
    setMode(snap.mode);
    setPatientName(snap.patient_name || "");
    setPatientId(snap.patient_id || "");
    setSelectedTemplateId(snap.template_id || null);
    setEditableTranscript(snap.transcript || "");
    setTranscript(snap.transcript || "");
    transcriptRef.current = snap.transcript || "";
    setElapsed(snap.elapsed || 0);
    setHasRecording(false); // no audio blob to recover
    setStage("review");
    setRecovery(null);
    toast.success("Recovered your in-progress transcript. Save as a draft or generate a letter.");
  }, []);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcript, interimText]);

  // Pre-warm Deepgram token on mount, unless we know the user will be using
  // the accurate medical engine (which uses batch transcription after Stop
  // and never opens a Deepgram stream).
  useEffect(() => {
    if (useMedicalDictation) {
      // Signal "ready" so the Start button isn't disabled — we don't need Deepgram.
      setDeepgramReady(true);
      return;
    }
    (async () => {
      try {
        const { data, error } = await supabase.functions.invoke("deepgram-token");
        if (!error && data?.key) {
          deepgramKeyRef.current = data.key;
          setDeepgramReady(true);
        }
      } catch (e) {
        console.error("[transcription] token pre-warm failed", e);
      }
    })();
  }, [useMedicalDictation]);

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
      // If we're recording and the WS is dead, trigger immediate reconnect.
      // Skip when we're using the accurate medical engine — there's no live
      // transcription stream to reconnect to.
      if (useMedicalDictationRef.current) return;
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

  const openWebSocket = useCallback(async (opts?: { forceFreshToken?: boolean }): Promise<WebSocket> => {
    // Deepgram short-lived tokens (default ~30s) can expire between the initial
    // connection and any later reconnect. When reconnecting we always ask for a
    // fresh one so a stale key doesn't silently fail the handshake.
    let key = opts?.forceFreshToken ? null : deepgramKeyRef.current;
    if (!key) {
      const { data, error } = await supabase.functions.invoke("deepgram-token");
      if (error || !data?.key) throw new Error(error?.message || "Could not start the transcription service");
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
        reject(new Error("Transcription service timed out. Check your connection and try again."));
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
        reject(new Error("Could not connect to the transcription service"));
      };
    });
  }, []);

  // On reconnect we DELIBERATELY do not replay buffered chunks. They are
  // mid-stream webm data captured after the recorder had already emitted its
  // opening header, so Deepgram's decoder can't parse them in isolation — the
  // socket would look healthy but the live transcript would never resume.
  //
  // Instead we restart the MediaRecorder (see restartMediaRecorderForReconnect)
  // so a fresh webm stream, complete with its header, flows to the new socket.
  // The audio for the final letter remains in chunksRef so nothing is lost.
  const dropPendingChunks = useCallback(() => {
    pendingChunksRef.current = [];
    setBufferedSeconds(0);
  }, []);

  // Stop the current MediaRecorder and start a fresh one on the same MediaStream
  // so the next data chunks begin with a fresh webm header. Called after a
  // successful WebSocket reconnect to let Deepgram start decoding again.
  const restartMediaRecorderForReconnect = useCallback(() => {
    const current = mediaRecorderRef.current;
    const stream = streamRef.current;
    if (!stream) return;
    // Save state that startRecording would reset — pause flag, elapsed time, etc.
    const wasPaused = isPausedRef.current;
    try {
      if (current && current.state !== "inactive") {
        // Detach handlers so the trailing ondataavailable / onstop from the old
        // recorder don't interfere with the new one.
        current.ondataavailable = null;
        current.onstop = null;
        current.stop();
      }
    } catch (e) {
      console.warn("[Transcription] Old MediaRecorder stop failed:", e);
    }

    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "audio/webm";
    const recorder = new MediaRecorder(stream, { mimeType });
    mediaRecorderRef.current = recorder;

    recorder.ondataavailable = (e) => {
      if (e.data.size === 0) return;
      chunksRef.current.push(e.data);
      if (isPausedRef.current) return;
      if (recorder.state !== "recording") return;
      const currentWs = wsRef.current;
      if (currentWs && currentWs.readyState === WebSocket.OPEN) {
        try {
          currentWs.send(e.data);
        } catch (err) {
          console.error("[Transcription] Send failed post-reconnect:", err);
        }
      }
    };
    recorder.onstop = () => {
      setHasRecording(chunksRef.current.length > 0);
    };
    recorder.start(250);

    // Restore paused state if the user was paused when reconnect fired.
    isPausedRef.current = wasPaused;
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
        const ws = await openWebSocket({ forceFreshToken: true });
        wsRef.current = ws;
        attachWebSocketHandlers(ws);

        // Discard any mid-stream chunks captured while offline — they can't be
        // decoded standalone. Then restart the MediaRecorder so the new socket
        // gets a fresh webm stream (with header) it can actually parse.
        dropPendingChunks();
        restartMediaRecorderForReconnect();

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
  }, [openWebSocket, attachWebSocketHandlers, dropPendingChunks, restartMediaRecorderForReconnect]);

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
      isPausedRef.current = false;
      hadDisconnectRef.current = false;
      setBufferedSeconds(0);
      setStreamHealth("connected");

      // Read through the ref, NOT the closure variable.
      //
      // startRecording is memoised and `mode` is not one of its dependencies,
      // so the closure captures whichever value useMedicalDictation had when
      // the callback was created — false, because the page opens in
      // consultation mode. Switching to Dictation did not recreate the
      // callback, so the streaming engine was opened for every recording
      // regardless of the selected module. The ref is updated by an effect on
      // every render and is always current.
      const medicalDictation = useMedicalDictationRef.current;

      // For the enhanced engine we intentionally skip the live streaming
      // provider — audio is transcribed in ~10s segments instead, so the user
      // only ever sees one transcript. Otherwise open the socket and mic in
      // parallel for the fastest start.
      let ws: WebSocket | null = null;
      let stream: MediaStream;
      if (medicalDictation) {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } else {
        const [w, s] = await Promise.all([
          openWebSocket(),
          navigator.mediaDevices.getUserMedia({ audio: true }),
        ]);
        ws = w;
        stream = s;
      }
      wsRef.current = ws;
      streamRef.current = stream;
      chunksRef.current = [];
      if (ws) attachWebSocketHandlers(ws);

      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";

      const recorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data.size === 0) return;
        chunksRef.current.push(e.data);

        // Soft pause: while paused we stop forwarding to the transcription service
        // (so the live transcript stops) but the MediaRecorder keeps running so the
        // audio file stays continuous and pause/resume is reliable across browsers.
        if (isPausedRef.current) return;

        // Also skip when MediaRecorder isn't in "recording" state (e.g. while stopping)
        if (recorder.state !== "recording") return;

        const currentWs = wsRef.current;
        if (currentWs && currentWs.readyState === WebSocket.OPEN) {
          try {
            currentWs.send(e.data);
          } catch (err) {
            console.error("[transcription] send failed, buffering:", err);
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

      // Accurate dictation live-transcript: a second MediaRecorder emits a
      // fresh, self-contained webm segment every 10s. Each segment is
      // uploaded and run through MedASR, and the returned text is appended
      // to the on-screen transcript so the clinician can review as they go.
      if (medicalDictation) {
        try {
          segmentChunksRef.current = [];
          const segRecorder = new MediaRecorder(stream, { mimeType });
          segRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) segmentChunksRef.current.push(e.data);
          };
          segRecorder.onstop = () => {
            const parts = segmentChunksRef.current;
            segmentChunksRef.current = [];
            if (parts.length === 0) return;
            const blob = new Blob(parts, { type: "audio/webm" });
            void transcribeSegmentAndAppend(blob);
          };
          segmentRecorderRef.current = segRecorder;
          segRecorder.start();

          segmentTickRef.current = setInterval(() => {
            const active = segmentRecorderRef.current;
            if (!active || active.state !== "recording") return;
            if (isPausedRef.current) return; // don't transcribe silence during a pause
            try {
              active.stop();
              // start() throws if the previous stop hasn't fully settled; a
              // microtask delay is enough for the state to become "inactive".
              queueMicrotask(() => {
                try {
                  if (active.state === "inactive") active.start();
                } catch (err) {
                  console.warn("[Segment] Restart failed:", err);
                }
              });
            } catch (err) {
              console.warn("[Segment] Stop failed:", err);
            }
          }, 10000);
        } catch (err) {
          console.warn("[Segment] Could not start segment recorder:", err);
        }
      }

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

  // Pause/resume use a soft flag rather than MediaRecorder.pause()/resume(), which
  // silently fails on iOS Safari and some Chrome versions when the audio session
  // hiccups. With the flag, MediaRecorder keeps running uninterrupted and we just
  // stop forwarding chunks to the transcription service while paused.
  const pauseRecording = useCallback(() => {
    if (!mediaRecorderRef.current) return;
    isPausedRef.current = true;
    setIsPaused(true);
    elapsedBeforePauseRef.current = elapsed;
    if (timerRef.current) clearInterval(timerRef.current);
    // KeepAlive interval keeps the transcription socket alive during the pause.
  }, [elapsed]);

  const resumeRecording = useCallback(() => {
    if (!mediaRecorderRef.current) {
      toast.error("Recording was lost. Please start a new one.");
      setIsPaused(false);
      setIsRecording(false);
      return;
    }

    isPausedRef.current = false;
    setIsPaused(false);

    // Restart wall-clock timer for the elapsed display.
    const startTime = Date.now();
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setElapsed(
        elapsedBeforePauseRef.current + Math.floor((Date.now() - startTime) / 1000)
      );
    }, 1000);

    // If the transcription WS dropped during the pause (KeepAlive failed, browser
    // idle, etc.), trigger a reconnect so the live transcript resumes.
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.log("[record] WS not open after resume — reconnecting");
      reconnectAttemptRef.current = 0;
      scheduleReconnectRef.current();
    }
  }, []);

  const cleanup = useCallback(() => {
    isStoppingRef.current = true;
    isPausedRef.current = false;

    if (timerRef.current) clearInterval(timerRef.current);
    if (keepAliveRef.current) clearInterval(keepAliveRef.current);
    if (healthCheckRef.current) clearInterval(healthCheckRef.current);
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    if (segmentTickRef.current) clearInterval(segmentTickRef.current);
    timerRef.current = null;
    keepAliveRef.current = null;
    healthCheckRef.current = null;
    reconnectTimerRef.current = null;
    segmentTickRef.current = null;

    // Stop the medical segment recorder — its onstop callback will fire one
    // last time and transcribe whatever it captured before Stop was pressed.
    const segRec = segmentRecorderRef.current;
    if (segRec && segRec.state !== "inactive") {
      try { segRec.stop(); } catch {/* ignore */}
    }
    segmentRecorderRef.current = null;

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

  // For accurate dictation: upload the finished audio and get the MedASR
  // transcript back so the user only ever sees the "real" transcript. The
  // resulting text populates both `transcript` (so the record card reflects it)
  // and `editableTranscript` (so review is pre-filled).
  const transcribeFinishedAudioForMedical = useCallback(async () => {
    if (chunksRef.current.length === 0) {
      setTranscribeError("No audio was captured.");
      return null;
    }
    setIsTranscribing(true);
    setTranscribeError(null);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      const blob = new Blob(chunksRef.current, { type: "audio/webm" });
      const fileName = `${user.id}/${Date.now()}.webm`;

      const { error: upErr } = await supabase.storage
        .from("audio-recordings")
        .upload(fileName, blob);
      if (upErr) throw new Error(`Upload failed: ${upErr.message}`);

      const { data, error } = await supabase.functions.invoke("transcribe-audio", {
        body: { audio_path: fileName, engine: "accurate" },
      });
      if (error) {
        let serverMessage = error.message;
        try {
          const ctx = (error as any).context;
          if (ctx?.json) serverMessage = (await ctx.json())?.error || serverMessage;
          else if (ctx?.text) {
            const body = await ctx.text();
            try { serverMessage = JSON.parse(body)?.error || body; } catch { serverMessage = body; }
          }
        } catch {/* ignore */}
        throw new Error(serverMessage);
      }
      if (data?.error) throw new Error(data.error);

      const text = (data?.transcript || "").trim();
      if (!text) throw new Error("No speech detected");

      transcriptRef.current = text;
      setTranscript(text);
      setEditableTranscript(text);
      medicalUploadPathRef.current = fileName;
      return { text, audio_path: fileName };
    } catch (err: any) {
      const msg = err?.message || "Transcription failed";
      setTranscribeError(msg);
      toast.error(msg);
      return null;
    } finally {
      setIsTranscribing(false);
    }
  }, []);

  // Upload a single 10-second segment blob to MedASR and APPEND the returned
  // text to the live transcript. Fire-and-forget: any single segment failing
  // (network blip, no speech, etc) doesn't stop subsequent segments from
  // running — the final Stop step still re-transcribes the full audio so
  // nothing is lost.
  const transcribeSegmentAndAppend = useCallback(async (segmentBlob: Blob) => {
    if (segmentBlob.size < 2000) return; // too small to be real speech
    segmentInFlightRef.current += 1;
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const fileName = `${user.id}/segments/${Date.now()}-${Math.random().toString(36).slice(2, 7)}.webm`;
      const { error: upErr } = await supabase.storage
        .from("audio-recordings")
        .upload(fileName, segmentBlob);
      if (upErr) {
        console.warn("[Segment] Upload failed:", upErr.message);
        return;
      }
      const { data, error } = await supabase.functions.invoke("transcribe-audio", {
        body: { audio_path: fileName, engine: "accurate" },
      });
      if (error) {
        console.warn("[Segment] Transcribe failed:", error.message);
        return;
      }
      const text = ((data?.transcript || "") as string).trim();
      if (!text) return;
      setTranscript((prev) => {
        const next = prev ? `${prev} ${text}` : text;
        transcriptRef.current = next;
        return next;
      });
    } catch (e) {
      console.warn("[Segment] Failed:", e);
    } finally {
      segmentInFlightRef.current = Math.max(0, segmentInFlightRef.current - 1);
    }
  }, []);

  useEffect(() => {
    return () => {
      releaseWakeLock();
      cleanup();
    };
  }, [releaseWakeLock, cleanup]);

  const processAudio = async (
    audioBlob: Blob,
    audioTranscript?: string,
    opts?: {
      // When present, skip the client upload — audio is already stored at this path.
      existingAudioPath?: string;
      // When "medical" or "client", the server should trust `audioTranscript` and not re-transcribe.
      transcriptSource?: "medical" | "client";
    }
  ) => {
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
      // Session finished normally — no need to offer recovery next time, and
      // the transcript-only auto-draft can be removed since we now have a real
      // recording + letter pair to replace it.
      clearRecovery();
      void deleteAutoDraft();
      navigate(`/letter/${letterId}`);
    };

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      const ext = audioBlob.type.includes("webm") ? "webm" : "wav";
      const fileName = opts?.existingAudioPath
        ? opts.existingAudioPath
        : `${user.id}/${Date.now()}.${ext}`;
      const skipUpload = !!opts?.existingAudioPath;

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

      // Kick off audio upload in background (non-blocking). Skipped when we're
      // reusing an already-uploaded path (accurate dictation flow).
      const uploadPromise = skipUpload
        ? Promise.resolve()
        : supabase.storage
            .from("audio-recordings")
            .upload(fileName, audioBlob)
            .then(({ error }) => {
              if (error) console.error("Background upload failed:", error);
            });

      // We need to await the audio upload when the server is expected to transcribe it:
      // - Dictation mode (server always re-transcribes for accuracy), unless the
      //   client already ran medical ASR and marked the transcript as final.
      // - Consultation with no live transcript (uploaded files, or full-disconnect)
      const clientTranscriptFinal =
        opts?.transcriptSource === "medical" || opts?.transcriptSource === "client";
      const willServerTranscribe =
        !clientTranscriptFinal &&
        (modeRef.current === "dictation" || !fallbackTranscript);

      if (willServerTranscribe && !skipUpload) {
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
            transcript_source: opts?.transcriptSource,
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
        // Supabase wraps the body in a FunctionsHttpError — pull the actual server message out so
        // we can show it to the user instead of the generic "non-2xx" text.
        let serverMessage = "";
        let quotaExceeded = false;
        try {
          const ctx = (fnError as any).context;
          if (ctx?.json) {
            const body = await ctx.json();
            serverMessage = body?.error || "";
            quotaExceeded = !!body?.quota_exceeded;
          } else if (ctx?.text) {
            const body = await ctx.text();
            try {
              const parsed = JSON.parse(body);
              serverMessage = parsed?.error || body;
              quotaExceeded = !!parsed?.quota_exceeded;
            } catch {
              serverMessage = body;
            }
          }
        } catch {
          /* couldn't parse body */
        }
        console.error("Edge function returned error:", { message: fnError.message, serverMessage, quotaExceeded });
        if (quotaExceeded) {
          toast.error(serverMessage || "Monthly letter quota reached. Upgrade to continue.");
          setProcessing(false);
          setProcessingStatus("");
          if (realtimeChannel) {
            supabase.removeChannel(realtimeChannel);
            realtimeChannel = null;
          }
          setTimeout(() => navigate("/settings/billing"), 1500);
          return;
        }
        // Don't immediately fail — the server may have completed and Realtime will catch it.
        setTimeout(() => {
          if (!navigated) {
            toast.error(serverMessage || fnError.message || "Letter generation failed");
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
  const goToReview = async () => {
    if (chunksRef.current.length === 0 && !transcriptRef.current) {
      toast.error("No recording available");
      return;
    }

    // For accurate dictation, wait for any in-flight 10-second segments to
    // finish transcribing so their text lands in the transcript before we
    // move to review. Cap the wait so a stuck request doesn't block the UI.
    if (useMedicalDictation && segmentInFlightRef.current > 0) {
      setIsTranscribing(true);
      const deadline = Date.now() + 8000;
      while (segmentInFlightRef.current > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200));
      }
      setIsTranscribing(false);
    }

    // Only fall back to a full-audio MedASR pass if the segmented approach
    // yielded nothing (all segments failed, network was down, etc). Normal
    // path: transcript is already built from segments; skip re-transcription.
    if (useMedicalDictation && !transcriptRef.current) {
      const result = await transcribeFinishedAudioForMedical();
      if (!result) return; // toast already shown
      setStage("review");
      return;
    }
    setEditableTranscript(transcriptRef.current);
    setStage("review");
  };

  // Actually generate letter from review stage
  const handleGenerateFromReview = async () => {
    const blob = new Blob(chunksRef.current, { type: "audio/webm" });

    // WYSIWYG GUARANTEE
    // ------------------
    // Anything leaving the review screen has been read (and possibly edited) by
    // the clinician, so it is authoritative for EVERY mode — never just the
    // accurate-dictation one. Marking it "client" stops the server re-running
    // ASR and silently generating the letter from different words than the ones
    // on screen. This is a safety property, not an optimisation: a letter must
    // never contain clinical content the clinician did not see and approve.
    if (!editableTranscript.trim()) {
      toast.error("The transcript is empty — nothing to generate a letter from.");
      return;
    }

    await processAudio(blob, editableTranscript, {
      existingAudioPath: medicalUploadPathRef.current || undefined,
      transcriptSource: "client",
    });
  };

  // Email the raw transcript to the user's saved recipients
  const [emailingTranscript, setEmailingTranscript] = useState(false);
  const handleEmailTranscript = async () => {
    if (!editableTranscript.trim()) {
      toast.error("No transcript to send");
      return;
    }
    setEmailingTranscript(true);
    try {
      const { data, error } = await supabase.functions.invoke("send-transcript-email", {
        body: {
          transcript: editableTranscript.trim(),
          patient_name: patientName || undefined,
          patient_id: patientId || undefined,
        },
      });
      if (error) throw new Error(error.message);
      if (data?.not_configured) {
        toast.error("Email isn't set up yet. Add a sending domain to enable it.");
        return;
      }
      if (data?.error) throw new Error(data.error);
      toast.success(`Transcript emailed to ${data.sent_to?.length || 0} recipient(s)`);
    } catch (err: any) {
      const msg = err.message || "Failed to send transcript";
      if (msg.includes("No recipient")) {
        toast.error("No recipients saved. Add addresses in Settings → Email.");
      } else {
        toast.error(msg);
      }
    } finally {
      setEmailingTranscript(false);
    }
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

  // Discard returns to a fresh recording state. Before wiping the in-memory data,
  // save whatever was captured as a draft recording (with the transcript as a draft
  // letter) so the user can recover it later from the Recordings or Letters list.
  const [discarding, setDiscarding] = useState(false);
  const handleDiscard = async () => {
    const transcriptToSave = (transcript || transcriptRef.current || "").trim();
    const audioBlob = chunksRef.current.length > 0
      ? new Blob(chunksRef.current, { type: "audio/webm" })
      : null;

    // If there's anything worth saving, persist it as a draft before clearing.
    // If an auto-draft was already created during recording we UPDATE it in
    // place (adding the audio) instead of writing a second row.
    if (transcriptToSave || audioBlob) {
      setDiscarding(true);
      try {
        const { data: { user }, error: userErr } = await supabase.auth.getUser();
        if (userErr) throw new Error(`Auth: ${userErr.message}`);
        if (!user) throw new Error("You're not signed in.");

        let audioPath: string | null = null;
        if (audioBlob) {
          audioPath = `${user.id}/${Date.now()}-draft.webm`;
          const { error: upErr } = await supabase.storage
            .from("audio-recordings")
            .upload(audioPath, audioBlob);
          if (upErr) throw new Error(`Audio upload: ${upErr.message}`);
        }

        const existingRecId = autoDraftRecordingIdRef.current;
        if (existingRecId) {
          const { error: updRecErr } = await supabase
            .from("recordings")
            .update({
              audio_path: audioPath ?? "",
              duration_seconds: elapsed,
              patient_name: patientName || null,
              patient_id: patientId || null,
              mode: modeRef.current,
              template_id: selectedTemplateId,
            })
            .eq("id", existingRecId);
          if (updRecErr) throw new Error(`Recording update: ${updRecErr.message}`);

          if (autoDraftLetterIdRef.current && transcriptToSave) {
            const { error: updLetErr } = await supabase
              .from("letters")
              .update({
                transcript: transcriptToSave,
                patient_name: patientName || null,
                patient_id: patientId || null,
                template_id: selectedTemplateId || null,
              })
              .eq("id", autoDraftLetterIdRef.current);
            if (updLetErr) throw new Error(`Letter update: ${updLetErr.message}`);
          }
          autoDraftRecordingIdRef.current = null;
          autoDraftLetterIdRef.current = null;
        } else {
          const { data: recording, error: insRecErr } = await supabase
            .from("recordings")
            .insert({
              user_id: user.id,
              audio_path: audioPath ?? "",
              status: "draft",
              duration_seconds: elapsed,
              patient_name: patientName || null,
              patient_id: patientId || null,
              mode: modeRef.current,
              template_id: selectedTemplateId,
            })
            .select()
            .single();
          if (insRecErr || !recording) {
            throw new Error(`Recording insert: ${insRecErr?.message || "unknown"}`);
          }
          if (transcriptToSave) {
            const { error: insLetErr } = await supabase.from("letters").insert({
              recording_id: recording.id,
              user_id: user.id,
              transcript: transcriptToSave,
              letter_content: null,
              status: "draft",
              patient_name: patientName || null,
              patient_id: patientId || null,
              template_id: selectedTemplateId || null,
            });
            if (insLetErr) throw new Error(`Letter insert: ${insLetErr.message}`);
          }
        }
        toast.success("Saved as a draft — you can find it in Recordings or Letters.");
      } catch (e: any) {
        console.error("[record] Failed to save discard draft:", e);
        // Surface the actual error so we know why the draft didn't appear —
        // previously this was a generic message that hid real RLS / schema issues.
        toast.error(e?.message || "Couldn't save as a draft — discarding anyway.");
      } finally {
        setDiscarding(false);
      }
    }

    chunksRef.current = [];
    setElapsed(0);
    setHasRecording(false);
    setTranscript("");
    setInterimText("");
    transcriptRef.current = "";
    setEditableTranscript("");
    setStage("record");
    medicalUploadPathRef.current = null;
    setTranscribeError(null);
    clearRecovery();
  };

  const formatTime = (s: number) =>
    `${Math.floor(s / 60).toString().padStart(2, "0")}:${(s % 60).toString().padStart(2, "0")}`;

  const hasStopped = !isRecording && hasRecording;
  const hasTranscript = transcript.length > 0 || interimText.length > 0;
  const canToggleMode = !isRecording && !hasStopped && !processing;
  const canEditPatient = !isRecording && !processing;

  // Auto-process when dictation finishes and the user has opted to skip the
  // review step. Fires exactly once when `hasStopped` flips true.
  const autoProcessFiredRef = useRef(false);
  useEffect(() => {
    if (!hasStopped) {
      autoProcessFiredRef.current = false;
      return;
    }
    if (autoProcessFiredRef.current) return;
    if (processing) return;
    if (isTranscribing) return;
    if (modeRef.current !== "dictation") return;
    if (!skipDictationReview) return;
    if (chunksRef.current.length === 0) return;

    autoProcessFiredRef.current = true;
    (async () => {
      const blob = new Blob(chunksRef.current, { type: "audio/webm" });

      if (useMedicalDictation) {
        // Let any in-flight rolling segments land first so their text is
        // included, then only fall back to a full-audio pass if the segmented
        // approach produced nothing at all.
        if (segmentInFlightRef.current > 0) {
          setIsTranscribing(true);
          const deadline = Date.now() + 8000;
          while (segmentInFlightRef.current > 0 && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 200));
          }
          setIsTranscribing(false);
        }

        if (!transcriptRef.current) {
          const result = await transcribeFinishedAudioForMedical();
          if (!result) {
            autoProcessFiredRef.current = false; // let the user retry via the button
            return;
          }
        }
      }

      // The transcript was displayed live on screen during recording, so it is
      // what the clinician saw — send it as authoritative for every mode.
      await processAudio(blob, transcriptRef.current || undefined, {
        existingAudioPath: medicalUploadPathRef.current || undefined,
        transcriptSource: transcriptRef.current ? "client" : undefined,
      });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasStopped, skipDictationReview, isTranscribing, useMedicalDictation]);

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
        <div className="space-y-4">
          {/* Recovery banner: a leftover in-progress transcript from an accidentally
              closed session, offered on next open. */}
          {recovery && stage === "record" && !isRecording && !hasRecording && (
            <div className="rounded-2xl border border-primary/40 bg-primary/5 p-4 flex items-start justify-between gap-4 flex-wrap">
              <div className="flex items-start gap-3 min-w-0 flex-1">
                <div className="w-9 h-9 rounded-lg bg-primary/15 text-primary flex items-center justify-center flex-shrink-0">
                  <RotateCcw className="h-4 w-4" />
                </div>
                <div className="min-w-0">
                  <p className="font-medium text-sm text-slate-900 dark:text-slate-100">
                    Recover your in-progress transcript?
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {(recovery.transcript || "").split(/\s+/).filter(Boolean).length} words captured
                    {recovery.patient_name ? ` · ${recovery.patient_name}` : ""}
                    {" · saved "}
                    {Math.max(1, Math.round((Date.now() - recovery.savedAt) / 60000))}m ago.
                    Audio isn't recovered — just the transcript.
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={() => restoreRecovery(recovery)} className="gap-1.5">
                  Recover
                </Button>
                <Button size="sm" variant="ghost" onClick={clearRecovery}>
                  Discard
                </Button>
              </div>
            </div>
          )}

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

          {/* Dictation engine picker — only visible when dictation mode is selected.
              Duplicates the Settings control so clinicians can flip engines in one place. */}
          {mode === "dictation" && stage === "record" && (
            <div className="rounded-2xl border border-border/60 bg-white dark:bg-slate-900 shadow-[0_1px_3px_rgba(21,33,52,0.04)] p-3 sm:p-4">
              <div className="flex items-center justify-between gap-3 mb-2 flex-wrap">
                <div>
                  <p className="text-xs font-semibold text-slate-600 dark:text-slate-400 uppercase tracking-wide">Dictation transcription engine</p>
                  <p className="text-xs text-muted-foreground mt-0.5">Choose the engine for this session. Saved to your profile.</p>
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => canToggleMode && dictationEngineMutation.mutate("fast")}
                  disabled={!canToggleMode || dictationEngineMutation.isPending}
                  className={`text-left rounded-lg border p-3 transition-colors ${
                    dictationEngine === "fast"
                      ? "border-primary bg-primary/5"
                      : "border-border hover:border-border/80"
                  } ${!canToggleMode ? "opacity-60 cursor-not-allowed" : ""}`}
                >
                  <p className="font-medium text-sm text-slate-900 dark:text-slate-100">Standard</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Live word-by-word transcript. Fastest, slightly lower accuracy.
                  </p>
                </button>
                <button
                  type="button"
                  onClick={() => canToggleMode && dictationEngineMutation.mutate("accurate")}
                  disabled={!canToggleMode || dictationEngineMutation.isPending}
                  className={`text-left rounded-lg border p-3 transition-colors ${
                    dictationEngine === "accurate"
                      ? "border-primary bg-primary/5"
                      : "border-border hover:border-border/80"
                  } ${!canToggleMode ? "opacity-60 cursor-not-allowed" : ""}`}
                >
                  <p className="font-medium text-sm text-slate-900 dark:text-slate-100">Enhanced</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Highest accuracy for clinical terminology. Transcript updates every ~10 seconds as you dictate.
                  </p>
                </button>
              </div>
            </div>
          )}

          {/* Patient info + template */}
          {stage === "record" && (
            <div className="bg-white dark:bg-slate-900 rounded-2xl border border-border/60 shadow-[0_1px_3px_rgba(21,33,52,0.04)] p-4 space-y-4">
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

          {/* Consultation recording tip */}
          {stage === "record" && mode === "consultation" && !isRecording && !hasStopped && !processing && (
            <div className="bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-900 rounded-xl p-3 text-xs text-blue-900 dark:text-blue-200 flex gap-2">
              <Sparkles className="h-3.5 w-3.5 mt-0.5 shrink-0 text-blue-600 dark:text-blue-400" />
              <div>
                <strong>Tip for best letters:</strong> at the end of the consultation, briefly
                summarise the diagnosis, any medications you prescribed or suggested, and the
                management plan. The AI uses this summary as a backbone for the letter.
              </div>
            </div>
          )}

          {stage === "record" && (
          <div className="grid grid-cols-1 lg:grid-cols-[380px_1fr] gap-4 items-stretch">
            {/* Left panel — Recording controls */}
            <div className="bg-white dark:bg-slate-900 rounded-2xl border border-border/60 shadow-[0_1px_3px_rgba(21,33,52,0.04)] p-6">
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
                    : isTranscribing
                    ? "● Transcribing"
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
                  <div className="w-full space-y-3 pt-2">
                    <Button
                      onClick={goToReview}
                      disabled={isTranscribing}
                      className="w-full gap-2 h-11"
                    >
                      {isTranscribing ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Transcribing…
                        </>
                      ) : (
                        <>
                          Review Transcript
                          <ChevronRight className="h-4 w-4" />
                        </>
                      )}
                    </Button>
                    {/* Discard separated visually so accidental clicks are unlikely.
                        A confirm dialog also guards against mis-taps — Mohamed
                        reported clinicians losing sessions to accidental clicks. */}
                    <div className="pt-3 border-t border-border/40 flex justify-center">
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <button
                            type="button"
                            disabled={discarding}
                            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                          >
                            {discarding ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <RotateCcw className="h-3 w-3" />
                            )}
                            {discarding ? "Saving draft..." : "Discard (saves as draft)"}
                          </button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Discard this recording?</AlertDialogTitle>
                            <AlertDialogDescription>
                              We'll save your transcript{chunksRef.current.length > 0 ? " and audio" : ""} as a
                              draft in Recordings so you can come back to it — but the current
                              session on this page will be cleared.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Keep recording</AlertDialogCancel>
                            <AlertDialogAction onClick={handleDiscard}>
                              Discard &amp; save draft
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
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
            <div className="bg-white dark:bg-slate-900 rounded-2xl border border-border/60 shadow-[0_1px_3px_rgba(21,33,52,0.04)] flex flex-col min-h-[640px]">
              <div className="px-6 py-4 border-b border-border/60 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  {useMedicalDictation ? "Transcript" : "Live Transcript"}
                </h3>
                {isRecording && !isPaused && streamHealth === "connected" && !useMedicalDictation && (
                  <span className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
                    <span className="relative flex h-2 w-2">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
                    </span>
                    Listening
                  </span>
                )}
                {isRecording && useMedicalDictation && (
                  <span className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
                    <span className="relative flex h-2 w-2">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
                    </span>
                    Recording
                  </span>
                )}
                {isTranscribing && (
                  <span className="flex items-center gap-1.5 text-xs text-primary">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Transcribing…
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

              <div className="flex-1 overflow-y-auto p-5 flex flex-col">
                {useMedicalDictation && !transcript && (
                  <div className="mb-3 rounded-xl border border-primary/30 bg-primary/5 px-4 py-3 text-xs leading-relaxed text-slate-700 dark:text-slate-300">
                    <div className="flex items-start gap-2">
                      <Stethoscope className="h-3.5 w-3.5 mt-0.5 text-primary flex-shrink-0" />
                      <div>
                        <div className="font-medium text-slate-900 dark:text-slate-100 mb-0.5">
                          Enhanced dictation
                        </div>
                        Your transcript is built in ~10 second segments as you speak. The
                        first block of text should appear about 10–15 seconds
                        after you start dictating.
                      </div>
                    </div>
                  </div>
                )}
                <Textarea
                  value={transcript}
                  onChange={(e) => {
                    setTranscript(e.target.value);
                    transcriptRef.current = e.target.value;
                  }}
                  placeholder={
                    useMedicalDictation
                      ? isRecording
                        ? "Recording… transcript will appear here every ~10 seconds."
                        : isTranscribing
                        ? "Transcribing with the medical engine…"
                        : "Your transcript will appear here after recording."
                      : isRecording
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
            <div className="bg-white dark:bg-slate-900 rounded-2xl border border-border/60 shadow-[0_1px_3px_rgba(21,33,52,0.04)]">
              <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-4 flex-wrap">
                <div>
                  <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                    Review Transcript
                  </h3>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                    Focus on diagnoses and medications — make sure they're captured correctly.
                    Don't worry about minor typos or grammar; the AI handles those.
                  </p>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
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
                    variant="outline"
                    onClick={handleEmailTranscript}
                    disabled={processing || emailingTranscript || !editableTranscript.trim()}
                    className="gap-2"
                    title="Email the raw transcript to your saved recipients"
                  >
                    {emailingTranscript ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Mail className="h-4 w-4" />
                    )}
                    Email Transcript
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
                {mode === "consultation" && (
                  <div className="mb-4 px-3 py-2 rounded-md bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-900 text-xs text-blue-900 dark:text-blue-200 flex gap-2">
                    <Sparkles className="h-3.5 w-3.5 mt-0.5 shrink-0 text-blue-600 dark:text-blue-400" />
                    <div>
                      <strong>Check the end of the transcript</strong> for the summary section
                      (diagnosis, medications, plan) if you recorded one. That section is the
                      most important for letter accuracy.
                    </div>
                  </div>
                )}
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
