import { useState, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import { Mic, Square, ArrowLeft, Loader2 } from "lucide-react";
import { Stethoscope } from "lucide-react";

const Record = () => {
  const navigate = useNavigate();
  const [isRecording, setIsRecording] = useState(false);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
      mediaRecorderRef.current = mediaRecorder;
      chunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      mediaRecorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        setAudioBlob(blob);
        setAudioUrl(URL.createObjectURL(blob));
        stream.getTracks().forEach((t) => t.stop());
      };

      mediaRecorder.start(1000);
      setIsRecording(true);
      setElapsed(0);
      timerRef.current = setInterval(() => setElapsed((e) => e + 1), 1000);
    } catch {
      toast.error("Microphone access denied");
    }
  }, []);

  const stopRecording = useCallback(() => {
    mediaRecorderRef.current?.stop();
    setIsRecording(false);
    if (timerRef.current) clearInterval(timerRef.current);
  }, []);

  const handleSubmit = async () => {
    if (!audioBlob) return;
    setProcessing(true);

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      // Upload audio
      const fileName = `${user.id}/${Date.now()}.webm`;
      const { error: uploadError } = await supabase.storage
        .from("audio-recordings")
        .upload(fileName, audioBlob);
      if (uploadError) throw uploadError;

      // Create recording record
      const { data: recording, error: recError } = await supabase
        .from("recordings")
        .insert({
          user_id: user.id,
          audio_path: fileName,
          status: "processing",
          duration_seconds: elapsed,
        })
        .select()
        .single();
      if (recError) throw recError;

      // Call edge function to process
      const { data: fnData, error: fnError } = await supabase.functions.invoke("generate-letter", {
        body: { recording_id: recording.id, audio_path: fileName },
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
              {isRecording ? "Recording... tap to stop" : "Tap to start recording"}
            </p>

            {/* Playback */}
            {audioUrl && !isRecording && (
              <div className="w-full space-y-4">
                <audio controls src={audioUrl} className="w-full" />
                <Button
                  onClick={handleSubmit}
                  className="w-full gap-2"
                  disabled={processing}
                >
                  {processing ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Processing with AI...
                    </>
                  ) : (
                    "Generate Letter"
                  )}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    setAudioBlob(null);
                    setAudioUrl(null);
                    setElapsed(0);
                  }}
                  className="w-full"
                  disabled={processing}
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
