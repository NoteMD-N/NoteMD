import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Mic, Search, MoreHorizontal, FileText, Trash2, Sparkles, Loader2 } from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";

const statusColors: Record<string, string> = {
  uploaded: "bg-muted text-muted-foreground",
  processing: "bg-warning/15 text-warning",
  transcribed: "bg-accent/15 text-accent",
  letter_generated: "bg-success/15 text-success",
  error: "bg-destructive/15 text-destructive",
};

const formatDuration = (seconds: number | null) => {
  if (!seconds) return "--:--";
  const m = Math.floor(seconds / 60).toString().padStart(2, "0");
  const s = (seconds % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
};

const Recordings = () => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");

  const { data: recordings = [], isLoading } = useQuery({
    queryKey: ["recordings-with-letters"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("recordings")
        .select("*, letters(id, status)")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data;
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("recordings").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["recordings-with-letters"] });
      toast.success("Recording deleted");
    },
    onError: () => {
      toast.error("Failed to delete recording");
    },
  });

  // (Re-)generate a letter for an existing recording. Used both when there's no
  // letter yet ("Generate Letter") and when one exists ("Regenerate Letter").
  // If an existing letter is present, it's deleted first so generate-letter
  // can create a fresh one without violating any unique constraints.
  const [generatingId, setGeneratingId] = useState<string | null>(null);
  const handleGenerateForRecording = async (rec: any, existingLetterId: string | null) => {
    setGeneratingId(rec.id);
    try {
      if (existingLetterId) {
        await supabase.from("letters").delete().eq("id", existingLetterId);
      }
      const { data, error } = await supabase.functions.invoke("generate-letter", {
        body: {
          recording_id: rec.id,
          audio_path: rec.audio_path,
          mode: rec.mode || "consultation",
          patient_name: rec.patient_name || undefined,
          patient_id: rec.patient_id || undefined,
          template_id: rec.template_id || undefined,
        },
      });
      if (error) {
        // Pull the real server error out of the response body
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

      toast.success(existingLetterId ? "Letter regenerated" : "Letter generated");
      queryClient.invalidateQueries({ queryKey: ["recordings-with-letters"] });
      if (data?.letter_id) navigate(`/letter/${data.letter_id}`);
    } catch (err: any) {
      toast.error(err.message || "Failed to generate letter");
    } finally {
      setGeneratingId(null);
    }
  };

  const filtered = recordings.filter((rec) => {
    const q = search.toLowerCase();
    const matchesSearch =
      !q ||
      rec.id.toLowerCase().includes(q) ||
      (rec.patient_name || "").toLowerCase().includes(q) ||
      (rec.patient_id || "").toLowerCase().includes(q);
    const matchesStatus = statusFilter === "all" || rec.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const statuses = [...new Set(recordings.map((r) => r.status))];

  return (
    <div className="space-y-3">
      <div className="px-1 pt-1">
        <h1 className="font-heading text-2xl font-bold tracking-tight text-foreground">Recordings</h1>
        <p className="text-sm text-muted-foreground">Manage all your consultation recordings</p>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by patient name or ID..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-full sm:w-[180px]">
            <SelectValue placeholder="Filter by status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Statuses</SelectItem>
            {statuses.map((s) => (
              <SelectItem key={s} value={s}>
                {s.replace("_", " ")}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Table */}
      <Card className="rounded-2xl border-border/60 shadow-[0_1px_3px_rgba(21,33,52,0.04)]">
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6 space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16">
              <Mic className="mb-4 h-12 w-12 text-muted-foreground/40" />
              <h3 className="font-heading text-lg font-semibold text-foreground">No recordings found</h3>
              <p className="mb-4 text-sm text-muted-foreground">
                {search || statusFilter !== "all"
                  ? "Try adjusting your filters"
                  : "Start by recording a consultation"}
              </p>
              {!search && statusFilter === "all" && (
                <Button onClick={() => navigate("/record")} className="gap-2">
                  <Mic className="h-4 w-4" />
                  New Recording
                </Button>
              )}
            </div>
          ) : (
            <>
              {/* Mobile: stacked card list. Below sm we show one card per recording
                  so nothing gets clipped or requires horizontal scrolling. */}
              <ul className="sm:hidden divide-y divide-border/60">
                {filtered.map((rec) => {
                  const linkedLetters = rec.letters as any[];
                  const letter = linkedLetters?.[0];
                  return (
                    <li key={rec.id} className="p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <p className="font-medium text-sm text-foreground truncate">
                              {rec.patient_name || <span className="italic text-muted-foreground">No patient name</span>}
                            </p>
                            <Badge variant="secondary" className={statusColors[rec.status] || ""}>
                              {rec.status.replace("_", " ")}
                            </Badge>
                          </div>
                          <div className="mt-1 text-xs text-muted-foreground space-y-0.5">
                            {rec.patient_id && (
                              <div className="font-mono">{rec.patient_id}</div>
                            )}
                            <div>
                              {format(new Date(rec.created_at), "dd MMM yyyy, HH:mm")} · {formatDuration(rec.duration_seconds)}
                            </div>
                          </div>
                          <div className="mt-2 flex items-center gap-2 flex-wrap">
                            {letter ? (
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-8 text-xs gap-1.5"
                                onClick={() => navigate(`/letter/${letter.id}`)}
                              >
                                <FileText className="h-3.5 w-3.5" />
                                View letter
                              </Button>
                            ) : (
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-8 text-xs gap-1.5"
                                disabled={generatingId === rec.id || !rec.audio_path}
                                onClick={() => handleGenerateForRecording(rec, null)}
                              >
                                {generatingId === rec.id ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <Sparkles className="h-3.5 w-3.5" />
                                )}
                                Generate letter
                              </Button>
                            )}
                          </div>
                        </div>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-8 w-8 flex-shrink-0">
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            {letter && (
                              <DropdownMenuItem
                                disabled={generatingId === rec.id}
                                onClick={() => handleGenerateForRecording(rec, letter.id)}
                              >
                                <Sparkles className="mr-2 h-4 w-4" />
                                Regenerate Letter
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuItem
                              onClick={() => deleteMutation.mutate(rec.id)}
                              className="text-destructive focus:text-destructive"
                            >
                              <Trash2 className="mr-2 h-4 w-4" />
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </li>
                  );
                })}
              </ul>

              {/* Desktop: full table, wrapped in an overflow scroller so ultra-narrow
                  widths degrade gracefully instead of horizontally overflowing the page. */}
              <div className="hidden sm:block overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Patient</TableHead>
                      <TableHead className="hidden md:table-cell">Patient ID / NHS No.</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead className="hidden lg:table-cell">Duration</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Letter</TableHead>
                      <TableHead className="w-12"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filtered.map((rec) => {
                      const linkedLetters = rec.letters as any[];
                      const letter = linkedLetters?.[0];
                      return (
                        <TableRow key={rec.id}>
                          <TableCell>
                            {rec.patient_name ? (
                              <span className="font-medium">{rec.patient_name}</span>
                            ) : (
                              <span className="text-xs text-muted-foreground italic">Not set</span>
                            )}
                          </TableCell>
                          <TableCell className="hidden md:table-cell">
                            {rec.patient_id ? (
                              <span className="font-mono text-xs">{rec.patient_id}</span>
                            ) : (
                              <span className="text-xs text-muted-foreground italic">Not set</span>
                            )}
                          </TableCell>
                          <TableCell className="whitespace-nowrap">
                            {format(new Date(rec.created_at), "dd MMM yyyy, HH:mm")}
                          </TableCell>
                          <TableCell className="hidden lg:table-cell font-mono text-sm">
                            {formatDuration(rec.duration_seconds)}
                          </TableCell>
                          <TableCell>
                            <Badge variant="secondary" className={statusColors[rec.status] || ""}>
                              {rec.status.replace("_", " ")}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            {letter ? (
                              <Button
                                variant="link"
                                size="sm"
                                className="h-auto p-0 text-xs font-mono"
                                onClick={() => navigate(`/letter/${letter.id}`)}
                              >
                                View
                              </Button>
                            ) : (
                              <span className="text-xs text-muted-foreground">--</span>
                            )}
                          </TableCell>
                          <TableCell>
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button variant="ghost" size="icon" className="h-8 w-8">
                                  <MoreHorizontal className="h-4 w-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                {letter && (
                                  <DropdownMenuItem onClick={() => navigate(`/letter/${letter.id}`)}>
                                    <FileText className="mr-2 h-4 w-4" />
                                    View Letter
                                  </DropdownMenuItem>
                                )}
                                <DropdownMenuItem
                                  disabled={generatingId === rec.id || !rec.audio_path}
                                  onClick={() => handleGenerateForRecording(rec, letter?.id ?? null)}
                                >
                                  {generatingId === rec.id ? (
                                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                  ) : (
                                    <Sparkles className="mr-2 h-4 w-4" />
                                  )}
                                  {letter ? "Regenerate Letter" : "Generate Letter"}
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onClick={() => deleteMutation.mutate(rec.id)}
                                  className="text-destructive focus:text-destructive"
                                >
                                  <Trash2 className="mr-2 h-4 w-4" />
                                  Delete
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default Recordings;
