import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { letterRoute } from "@/lib/letter-route";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { SummaryCard } from "@/components/SummaryCard";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Mic, FileText, Clock, BarChart3, ArrowRight, User, Sparkles } from "lucide-react";
import { format, startOfMonth } from "date-fns";
import { useAuth } from "@/hooks/useAuth";
import { BrandLockup } from "@/components/BrandLogo";

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

const formatDuration = (seconds: number | null) => {
  if (!seconds) return "--:--";
  const m = Math.floor(seconds / 60).toString().padStart(2, "0");
  const s = (seconds % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
};

const Dashboard = () => {
  const navigate = useNavigate();
  const { user } = useAuth();

  const { data: recordings = [], isLoading: loadingRec } = useQuery({
    queryKey: ["recordings"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("recordings")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data;
    },
  });

  const { data: letters = [], isLoading: loadingLet } = useQuery({
    queryKey: ["letters"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("letters")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data;
    },
  });

  const loading = loadingRec || loadingLet;

  const monthStart = startOfMonth(new Date()).toISOString();
  const thisMonthRec = recordings.filter((r) => r.created_at >= monthStart).length;
  const thisMonthLet = letters.filter((l) => l.created_at >= monthStart).length;

  const recentRecordings = recordings.slice(0, 6);
  const getLetterForRecording = (recordingId: string) =>
    letters.find((l) => l.recording_id === recordingId);

  const firstName = user?.user_metadata?.full_name?.split(" ")[0];

  return (
    <div className="space-y-3">
      {/* Welcome hero — branded gradient with prominent logo */}
      <div className="relative overflow-hidden rounded-2xl border border-border/60 shadow-[0_1px_3px_rgba(21,33,52,0.04)] gradient-hero">
        {/* decorative glows */}
        <div className="pointer-events-none absolute -top-24 -right-24 h-72 w-72 rounded-full bg-white/5 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-20 -left-10 h-64 w-64 rounded-full bg-accent/15 blur-3xl" />

        <div className="relative flex flex-col gap-6 p-6 sm:p-8 md:flex-row md:items-center md:justify-between">
          <div className="flex-1 text-white">
            <div className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.16em] text-white/80 backdrop-blur-sm mb-3">
              <Sparkles className="h-3 w-3" />
              Clinical Documentation Suite
            </div>
            <h1 className="font-heading text-2xl sm:text-3xl font-bold tracking-tight">
              {firstName ? `Welcome back, ${firstName}` : "Welcome to NoteMD"}
            </h1>
            <p className="mt-2 text-sm sm:text-base text-white/70 max-w-md">
              Record consultations, review transcripts, and generate polished clinical letters —
              all from one place.
            </p>
            <div className="mt-5">
              <Button
                onClick={() => navigate("/record")}
                size="lg"
                className="gap-2 rounded-xl bg-white text-primary hover:bg-white/90 shadow-lg"
              >
                <Mic className="h-4 w-4" />
                New Recording
              </Button>
            </div>
          </div>
          {/* Logo lockup in a frosted card */}
          <div className="shrink-0 hidden sm:block">
            <div className="rounded-2xl bg-white px-6 py-5 shadow-xl">
              <BrandLockup className="h-16 w-auto object-contain" />
            </div>
          </div>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {loading ? (
          Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="bento-card-sm">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="mt-3 h-8 w-12" />
            </div>
          ))
        ) : (
          <>
            <SummaryCard title="Total Recordings" value={recordings.length} icon={Mic} />
            <SummaryCard title="Letters Generated" value={letters.length} icon={FileText} variant="accent" />
            <SummaryCard title="Recordings This Month" value={thisMonthRec} icon={BarChart3} />
            <SummaryCard title="Letters This Month" value={thisMonthLet} icon={Clock} variant="accent" />
          </>
        )}
      </div>

      {/* Recent recordings */}
      <div className="bento-card !p-0 overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4">
          <div>
            <h2 className="text-[15px] font-semibold text-foreground">Recent Recordings</h2>
            <p className="text-xs text-muted-foreground">Your latest consultation recordings</p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate("/recordings")}
            className="gap-1 rounded-lg text-primary"
          >
            View all <ArrowRight className="h-3.5 w-3.5" />
          </Button>
        </div>

        {loading ? (
          <div className="space-y-3 px-6 pb-6">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : recentRecordings.length === 0 ? (
          <div className="flex flex-col items-center justify-center px-6 py-14 border-t border-border/50">
            <Mic className="mb-4 h-12 w-12 text-muted-foreground/40" />
            <h3 className="font-heading text-lg font-semibold text-foreground">No recordings yet</h3>
            <p className="mb-4 text-sm text-muted-foreground">Start by recording a consultation</p>
            <Button onClick={() => navigate("/record")} className="gap-2 rounded-xl">
              <Mic className="h-4 w-4" />
              New Recording
            </Button>
          </div>
        ) : (
          <div className="overflow-x-auto border-t border-border/50">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="pl-6 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Patient</TableHead>
                  <TableHead className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Date</TableHead>
                  <TableHead className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Duration</TableHead>
                  <TableHead className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Status</TableHead>
                  <TableHead className="pr-6 text-right text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Letter</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recentRecordings.map((rec) => {
                  const letter = getLetterForRecording(rec.id);
                  return (
                    <TableRow key={rec.id} className="hover:bg-muted/30">
                      <TableCell className="pl-6">
                        {rec.patient_name ? (
                          <span className="flex items-center gap-1.5 text-[13px] font-medium">
                            <User className="h-3.5 w-3.5 text-muted-foreground" />
                            {rec.patient_name}
                          </span>
                        ) : (
                          <span className="text-xs italic text-muted-foreground">Not set</span>
                        )}
                      </TableCell>
                      <TableCell className="text-[13px] text-muted-foreground">
                        {format(new Date(rec.created_at), "dd MMM yyyy, HH:mm")}
                      </TableCell>
                      <TableCell className="font-mono text-[13px]">
                        {formatDuration(rec.duration_seconds)}
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary" className={statusColors[rec.status] || ""}>
                          {rec.status.replace("_", " ")}
                        </Badge>
                      </TableCell>
                      <TableCell className="pr-6 text-right">
                        {letter ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => navigate(letterRoute(letter.id))}
                            className="gap-1 rounded-lg text-primary"
                          >
                            <FileText className="h-3.5 w-3.5" />
                            View
                          </Button>
                        ) : (
                          <span className="text-xs text-muted-foreground">--</span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </div>
  );
};

export default Dashboard;
