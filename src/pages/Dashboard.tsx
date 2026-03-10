import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Stethoscope, Mic, LogOut, FileText, Clock, Plus } from "lucide-react";
import { format } from "date-fns";
import type { Tables } from "@/integrations/supabase/types";

type Recording = Tables<"recordings">;
type Letter = Tables<"letters">;

const statusColors: Record<string, string> = {
  uploaded: "bg-muted text-muted-foreground",
  processing: "bg-warning/15 text-warning",
  transcribed: "bg-accent/15 text-accent",
  letter_generated: "bg-success/15 text-success",
  error: "bg-destructive/15 text-destructive",
  draft: "bg-muted text-muted-foreground",
  reviewed: "bg-accent/15 text-accent",
  exported: "bg-success/15 text-success",
};

const Dashboard = () => {
  const navigate = useNavigate();
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [letters, setLetters] = useState<Letter[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const [recResult, letResult] = await Promise.all([
      supabase.from("recordings").select("*").order("created_at", { ascending: false }),
      supabase.from("letters").select("*").order("created_at", { ascending: false }),
    ]);

    if (recResult.data) setRecordings(recResult.data);
    if (letResult.data) setLetters(letResult.data);
    setLoading(false);
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    navigate("/auth");
  };

  const getLetterForRecording = (recordingId: string) =>
    letters.find((l) => l.recording_id === recordingId);

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border bg-card">
        <div className="container flex h-16 items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg gradient-primary">
              <Stethoscope className="h-5 w-5 text-primary-foreground" />
            </div>
            <h1 className="font-heading text-xl font-bold text-foreground">NoteMD</h1>
          </div>
          <div className="flex items-center gap-2">
            <Button onClick={() => navigate("/record")} size="sm" className="gap-2">
              <Plus className="h-4 w-4" />
              New Recording
            </Button>
            <Button onClick={handleLogout} variant="ghost" size="sm">
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </header>

      {/* Content */}
      <main className="container py-8">
        <div className="mb-6">
          <h2 className="font-heading text-2xl font-bold text-foreground">Dashboard</h2>
          <p className="text-sm text-muted-foreground">Your recordings and generated letters</p>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        ) : recordings.length === 0 ? (
          <Card className="shadow-card">
            <CardContent className="flex flex-col items-center justify-center py-16">
              <Mic className="mb-4 h-12 w-12 text-muted-foreground/40" />
              <h3 className="font-heading text-lg font-semibold text-foreground">No recordings yet</h3>
              <p className="mb-4 text-sm text-muted-foreground">
                Start by recording a consultation or uploading audio
              </p>
              <Button onClick={() => navigate("/record")} className="gap-2">
                <Mic className="h-4 w-4" />
                New Recording
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4">
            {recordings.map((rec) => {
              const letter = getLetterForRecording(rec.id);
              return (
                <Card
                  key={rec.id}
                  className="shadow-card transition-shadow hover:shadow-elevated cursor-pointer"
                  onClick={() => letter && navigate(`/letter/${letter.id}`)}
                >
                  <CardHeader className="pb-2">
                    <div className="flex items-center justify-between">
                      <CardTitle className="font-heading text-base">
                        Recording — {format(new Date(rec.created_at), "dd MMM yyyy, HH:mm")}
                      </CardTitle>
                      <Badge variant="secondary" className={statusColors[rec.status] || ""}>
                        {rec.status.replace("_", " ")}
                      </Badge>
                    </div>
                    <CardDescription className="flex items-center gap-3 text-xs">
                      <span className="flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {rec.duration_seconds ? `${Math.floor(rec.duration_seconds / 60)}m ${rec.duration_seconds % 60}s` : "—"}
                      </span>
                      {letter && (
                        <span className="flex items-center gap-1">
                          <FileText className="h-3 w-3" />
                          Letter: {letter.status}
                        </span>
                      )}
                    </CardDescription>
                  </CardHeader>
                </Card>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
};

export default Dashboard;
