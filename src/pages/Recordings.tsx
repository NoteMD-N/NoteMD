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
import { Mic, Search, MoreHorizontal, FileText, Trash2 } from "lucide-react";
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

  const filtered = recordings.filter((rec) => {
    const matchesSearch = rec.id.toLowerCase().includes(search.toLowerCase());
    const matchesStatus = statusFilter === "all" || rec.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const statuses = [...new Set(recordings.map((r) => r.status))];

  return (
    <div className="p-6 space-y-6">
      <div>
        <h2 className="font-heading text-2xl font-bold text-foreground">Recordings</h2>
        <p className="text-sm text-muted-foreground">Manage all your consultation recordings</p>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by ID..."
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
      <Card className="shadow-card">
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
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>ID</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Duration</TableHead>
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
                      <TableCell>
                        {letter ? (
                          <Button
                            variant="link"
                            size="sm"
                            className="h-auto p-0 text-xs font-mono"
                            onClick={() => navigate(`/letter/${letter.id}`)}
                          >
                            {letter.id.slice(0, 8)}
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
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default Recordings;
