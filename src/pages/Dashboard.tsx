import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Mic, FileText, Clock, BarChart3, ArrowRight } from "lucide-react";
import { format, startOfMonth } from "date-fns";

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

  const recentRecordings = recordings.slice(0, 5);

  const getLetterForRecording = (recordingId: string) =>
    letters.find((l) => l.recording_id === recordingId);

  const stats = [
    { label: "Total Recordings", value: recordings.length, icon: Mic, color: "text-primary" },
    { label: "Letters Generated", value: letters.length, icon: FileText, color: "text-accent" },
    { label: "This Month Recordings", value: thisMonthRec, icon: BarChart3, color: "text-primary" },
    { label: "This Month Letters", value: thisMonthLet, icon: Clock, color: "text-accent" },
  ];

  return (
    <div className="p-6 space-y-6">
      <div>
        <h2 className="font-heading text-2xl font-bold text-foreground">Dashboard</h2>
        <p className="text-sm text-muted-foreground">Your recordings and generated letters</p>
      </div>

      {/* Stats */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((stat) =>
          loading ? (
            <Card key={stat.label} className="shadow-card">
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-5 w-5 rounded" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-8 w-16" />
              </CardContent>
            </Card>
          ) : (
            <Card key={stat.label} className="shadow-card">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  {stat.label}
                </CardTitle>
                <stat.icon className={`h-5 w-5 ${stat.color}`} />
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-bold">{stat.value}</div>
              </CardContent>
            </Card>
          )
        )}
      </div>

      {/* Recent Recordings Table */}
      <Card className="shadow-card">
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="font-heading text-lg">Recent Recordings</CardTitle>
            <CardDescription>Your latest consultation recordings</CardDescription>
          </div>
          <Button variant="ghost" size="sm" onClick={() => navigate("/recordings")} className="gap-1">
            View All <ArrowRight className="h-4 w-4" />
          </Button>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : recentRecordings.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12">
              <Mic className="mb-4 h-12 w-12 text-muted-foreground/40" />
              <h3 className="font-heading text-lg font-semibold text-foreground">No recordings yet</h3>
              <p className="mb-4 text-sm text-muted-foreground">
                Start by recording a consultation
              </p>
              <Button onClick={() => navigate("/record")} className="gap-2">
                <Mic className="h-4 w-4" />
                New Recording
              </Button>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>ID</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recentRecordings.map((rec) => {
                  const letter = getLetterForRecording(rec.id);
                  return (
                    <TableRow key={rec.id}>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {rec.id.slice(0, 8)}
                      </TableCell>
                      <TableCell>{format(new Date(rec.created_at), "dd MMM yyyy, HH:mm")}</TableCell>
                      <TableCell className="font-mono text-sm">
                        {formatDuration(rec.duration_seconds)}
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary" className={statusColors[rec.status] || ""}>
                          {rec.status.replace("_", " ")}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        {letter ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => navigate(`/letter/${letter.id}`)}
                            className="gap-1"
                          >
                            <FileText className="h-3.5 w-3.5" />
                            View Letter
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
          )}
        </CardContent>
      </Card>

      {/* Recent Letters */}
      {letters.length > 0 && (
        <Card className="shadow-card">
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle className="font-heading text-lg">Recent Letters</CardTitle>
              <CardDescription>Your latest generated letters</CardDescription>
            </div>
            <Button variant="ghost" size="sm" onClick={() => navigate("/letters")} className="gap-1">
              View All <ArrowRight className="h-4 w-4" />
            </Button>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3">
              {letters.slice(0, 3).map((letter) => (
                <div
                  key={letter.id}
                  className="flex items-center justify-between rounded-lg border p-3 cursor-pointer hover:bg-muted/50 transition-colors"
                  onClick={() => navigate(`/letter/${letter.id}`)}
                >
                  <div className="flex items-center gap-3">
                    <FileText className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <p className="text-sm font-medium">
                        Letter <span className="font-mono text-muted-foreground">{letter.id.slice(0, 8)}</span>
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {format(new Date(letter.created_at), "dd MMM yyyy")}
                      </p>
                    </div>
                  </div>
                  <Badge variant="secondary" className={statusColors[letter.status] || ""}>
                    {letter.status}
                  </Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
};

export default Dashboard;
