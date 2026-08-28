import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Search, Download, Trash2, Loader2, ShieldAlert } from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";

type Match = {
  recording_id: string;
  letter_id: string | null;
  patient_name: string | null;
  patient_id: string | null;
  created_at: string;
  status: string;
  has_audio: boolean;
  has_letter: boolean;
  transcript_chars: number;
};

/**
 * Per-patient data subject requests (UK GDPR Art. 15, 17, 20).
 *
 * Deliberately a three-step flow — search, review, confirm — rather than a
 * single destructive button. Erasure cannot be undone, and patient names are
 * not unique, so the clinician must see exactly which records will be removed
 * before anything happens.
 */
const PatientDataRequest = () => {
  const [patientId, setPatientId] = useState("");
  const [patientName, setPatientName] = useState("");
  const [matches, setMatches] = useState<Match[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [erasing, setErasing] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const criteria = () => ({
    p_patient_id: patientId.trim() || null,
    p_patient_name: patientName.trim() || null,
  });

  const handleSearch = async () => {
    if (!patientId.trim() && !patientName.trim()) {
      toast.error("Enter an NHS number or a patient name");
      return;
    }
    setSearching(true);
    setMatches(null);
    try {
      const { data, error } = await supabase.rpc("gdpr_find_patient_records", criteria() as any);
      if (error) throw error;
      const rows = (data ?? []) as Match[];
      setMatches(rows);
      if (rows.length === 0) toast.info("No records matched");
    } catch (e: any) {
      toast.error(e?.message || "Search failed");
    } finally {
      setSearching(false);
    }
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const { data, error } = await supabase.rpc("gdpr_export_patient", criteria() as any);
      if (error) throw error;

      // Offer the export as a file the clinician can hand to the requester.
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const stamp = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = `patient-data-export-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.success("Export downloaded");
    } catch (e: any) {
      toast.error(e?.message || "Export failed");
    } finally {
      setExporting(false);
    }
  };

  const handleErase = async () => {
    setErasing(true);
    try {
      const { data, error } = await supabase.rpc("gdpr_erase_patient", {
        ...criteria(),
        // Guards against the record set changing between preview and confirm.
        p_expected_count: matches?.length ?? 0,
      } as any);
      if (error) throw error;
      const r = data as any;
      toast.success(
        `Erased ${r.recordings_deleted} recording(s), ${r.letters_deleted} letter(s) and ${r.audio_objects_deleted} audio file(s).`
      );
      setMatches([]);
      setPatientId("");
      setPatientName("");
    } catch (e: any) {
      toast.error(e?.message || "Erasure failed");
    } finally {
      setErasing(false);
      setConfirmOpen(false);
    }
  };

  const withAudio = matches?.filter((m) => m.has_audio).length ?? 0;
  const withLetter = matches?.filter((m) => m.has_letter).length ?? 0;

  return (
    <Card className="rounded-2xl border-border/60 shadow-[0_1px_3px_rgba(21,33,52,0.04)]">
      <CardHeader>
        <CardTitle>Patient data requests</CardTitle>
        <CardDescription>
          Locate, export or erase everything held for a single patient. Search by
          NHS number where possible — names are not unique.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="dsrPatientId">NHS number / patient ID</Label>
            <Input
              id="dsrPatientId"
              value={patientId}
              onChange={(e) => setPatientId(e.target.value)}
              placeholder="e.g. 943 476 5919"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="dsrPatientName">Patient name</Label>
            <Input
              id="dsrPatientName"
              value={patientName}
              onChange={(e) => setPatientName(e.target.value)}
              placeholder="Used only if no NHS number is given"
            />
          </div>
        </div>

        <Button onClick={handleSearch} disabled={searching} variant="outline" className="gap-2">
          {searching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
          {searching ? "Searching…" : "Search"}
        </Button>

        {matches && matches.length > 0 && (
          <div className="space-y-3 pt-1">
            <div className="flex items-center gap-2 flex-wrap text-sm">
              <Badge variant="secondary">{matches.length} record(s)</Badge>
              <Badge variant="secondary">{withLetter} letter(s)</Badge>
              <Badge variant="secondary">{withAudio} audio file(s)</Badge>
            </div>

            <div className="rounded-xl border border-border/60 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="text-left px-3 py-2">Patient</th>
                    <th className="text-left px-3 py-2">NHS no.</th>
                    <th className="text-left px-3 py-2 whitespace-nowrap">Date</th>
                    <th className="text-left px-3 py-2">Contains</th>
                  </tr>
                </thead>
                <tbody>
                  {matches.map((m) => (
                    <tr key={m.recording_id} className="border-t border-border/60">
                      <td className="px-3 py-2">{m.patient_name || <span className="italic text-muted-foreground">Not set</span>}</td>
                      <td className="px-3 py-2 font-mono text-xs">{m.patient_id || "—"}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{format(new Date(m.created_at), "dd MMM yyyy")}</td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {[
                          m.has_letter ? "letter" : null,
                          m.transcript_chars > 0 ? "transcript" : null,
                          m.has_audio ? "audio" : null,
                        ].filter(Boolean).join(", ") || "record only"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button onClick={handleExport} disabled={exporting} variant="outline" className="gap-2">
                {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                Export as JSON
              </Button>
              <Button
                onClick={() => setConfirmOpen(true)}
                disabled={erasing}
                variant="outline"
                className="gap-2 text-destructive hover:text-destructive"
              >
                <Trash2 className="h-4 w-4" />
                Erase permanently
              </Button>
            </div>
          </div>
        )}

        {matches && matches.length === 0 && (
          <p className="text-sm text-muted-foreground pt-1">
            No records matched. Check the NHS number, or try the patient's name.
          </p>
        )}
      </CardContent>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <ShieldAlert className="h-5 w-5 text-destructive" />
              Erase this patient's data?
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  This permanently deletes <b>{matches?.length ?? 0} recording(s)</b>,{" "}
                  <b>{withLetter} letter(s)</b> and <b>{withAudio} audio file(s)</b>.
                </p>
                <p>
                  It cannot be undone. The erasure is written to the audit log, recording
                  that it happened without retaining the content.
                </p>
                <p className="text-xs">
                  Note: erased data may persist in database backups until those backups
                  expire.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleErase}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {erasing ? "Erasing…" : "Erase permanently"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
};

export default PatientDataRequest;
