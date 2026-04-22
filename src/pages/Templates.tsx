import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Plus,
  Pencil,
  Trash2,
  Copy,
  Star,
  Loader2,
  Stethoscope,
  PenLine,
  FileText,
} from "lucide-react";
import { toast } from "sonner";

type Template = {
  id: string;
  user_id: string | null;
  name: string;
  description: string | null;
  prompt: string;
  mode: string;
  is_preset: boolean;
  is_default: boolean;
  created_at: string;
};

const Templates = () => {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<Template | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Template | null>(null);

  const [formName, setFormName] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formPrompt, setFormPrompt] = useState("");
  const [formMode, setFormMode] = useState<"consultation" | "dictation">("consultation");

  const { data: templates = [], isLoading } = useQuery({
    queryKey: ["templates", user?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("templates")
        .select("*")
        .order("is_preset", { ascending: false })
        .order("name", { ascending: true });
      if (error) throw error;
      return data as Template[];
    },
    enabled: !!user,
  });

  const presets = templates.filter((t) => t.is_preset);
  const myTemplates = templates.filter((t) => !t.is_preset);

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!user) throw new Error("Not authenticated");
      if (!formName.trim()) throw new Error("Name is required");
      if (!formPrompt.trim()) throw new Error("Prompt is required");

      if (editingTemplate && !editingTemplate.is_preset) {
        // Update existing
        const { error } = await supabase
          .from("templates")
          .update({
            name: formName.trim(),
            description: formDescription.trim() || null,
            prompt: formPrompt.trim(),
            mode: formMode,
          })
          .eq("id", editingTemplate.id);
        if (error) throw error;
      } else {
        // Create new
        const { error } = await supabase.from("templates").insert({
          user_id: user.id,
          name: formName.trim(),
          description: formDescription.trim() || null,
          prompt: formPrompt.trim(),
          mode: formMode,
          is_preset: false,
        });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["templates"] });
      setEditorOpen(false);
      resetForm();
      toast.success(editingTemplate ? "Template updated" : "Template created");
    },
    onError: (err: any) => {
      toast.error(err.message || "Failed to save template");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("templates").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["templates"] });
      setDeleteTarget(null);
      toast.success("Template deleted");
    },
    onError: () => toast.error("Failed to delete template"),
  });

  const setDefaultMutation = useMutation({
    mutationFn: async ({ id, mode }: { id: string; mode: string }) => {
      if (!user) throw new Error("Not authenticated");
      // First clear existing default for this mode
      await supabase
        .from("templates")
        .update({ is_default: false })
        .eq("user_id", user.id)
        .eq("mode", mode);
      // Set new default
      const { error } = await supabase
        .from("templates")
        .update({ is_default: true })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["templates"] });
      toast.success("Default template updated");
    },
    onError: () => toast.error("Failed to set default"),
  });

  const resetForm = () => {
    setFormName("");
    setFormDescription("");
    setFormPrompt("");
    setFormMode("consultation");
    setEditingTemplate(null);
  };

  const openNew = () => {
    resetForm();
    setEditorOpen(true);
  };

  const openEdit = (template: Template) => {
    setEditingTemplate(template);
    setFormName(template.name);
    setFormDescription(template.description || "");
    setFormPrompt(template.prompt);
    setFormMode((template.mode as "consultation" | "dictation") || "consultation");
    setEditorOpen(true);
  };

  const openCloneFromPreset = (template: Template) => {
    setEditingTemplate(null); // cloning creates new
    setFormName(`${template.name} (Copy)`);
    setFormDescription(template.description || "");
    setFormPrompt(template.prompt);
    setFormMode((template.mode as "consultation" | "dictation") || "consultation");
    setEditorOpen(true);
  };

  const ModeBadge = ({ mode }: { mode: string }) => (
    <Badge variant="outline" className="gap-1">
      {mode === "dictation" ? (
        <PenLine className="h-3 w-3" />
      ) : (
        <Stethoscope className="h-3 w-3" />
      )}
      {mode === "dictation" ? "Dictation" : "Consultation"}
    </Badge>
  );

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="font-heading text-2xl font-bold text-foreground">Letter Templates</h2>
          <p className="text-sm text-muted-foreground">
            Customise how your clinical letters are generated. Each template is a prompt that
            guides the AI's formatting, tone, and structure.
          </p>
        </div>
        <Button onClick={openNew} className="gap-2">
          <Plus className="h-4 w-4" />
          New Template
        </Button>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading templates...
        </div>
      ) : (
        <>
          {/* My Templates */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">My Templates</CardTitle>
              <CardDescription>
                Templates you've created or customised. Star one per mode to make it your default.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {myTemplates.length === 0 ? (
                <div className="text-center py-8 text-sm text-muted-foreground">
                  No custom templates yet. Create one from scratch or clone a preset below.
                </div>
              ) : (
                <div className="space-y-2">
                  {myTemplates.map((t) => (
                    <div
                      key={t.id}
                      className="flex items-start justify-between gap-4 p-4 rounded-lg border bg-card hover:bg-muted/30 transition-colors"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap mb-1">
                          <h4 className="font-medium">{t.name}</h4>
                          <ModeBadge mode={t.mode} />
                          {t.is_default && (
                            <Badge className="bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/20 gap-1">
                              <Star className="h-3 w-3 fill-current" />
                              Default
                            </Badge>
                          )}
                        </div>
                        {t.description && (
                          <p className="text-sm text-muted-foreground line-clamp-2">
                            {t.description}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        {!t.is_default && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              setDefaultMutation.mutate({ id: t.id, mode: t.mode })
                            }
                            title="Set as default for this mode"
                          >
                            <Star className="h-4 w-4" />
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => openEdit(t)}
                          title="Edit"
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setDeleteTarget(t)}
                          title="Delete"
                          className="text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Presets */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Preset Templates</CardTitle>
              <CardDescription>
                Starting points maintained by NoteMD. Clone any preset to customise it for your
                own use.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {presets.map((t) => (
                  <div
                    key={t.id}
                    className="flex items-start justify-between gap-4 p-4 rounded-lg border bg-card hover:bg-muted/30 transition-colors"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap mb-1">
                        <FileText className="h-4 w-4 text-muted-foreground" />
                        <h4 className="font-medium">{t.name}</h4>
                        <ModeBadge mode={t.mode} />
                      </div>
                      {t.description && (
                        <p className="text-sm text-muted-foreground">{t.description}</p>
                      )}
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => openCloneFromPreset(t)}
                      className="gap-2 shrink-0"
                    >
                      <Copy className="h-3.5 w-3.5" />
                      Clone
                    </Button>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </>
      )}

      {/* Editor dialog */}
      <Dialog open={editorOpen} onOpenChange={(open) => { setEditorOpen(open); if (!open) resetForm(); }}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editingTemplate ? "Edit Template" : "New Template"}
            </DialogTitle>
            <DialogDescription>
              The prompt is what the AI reads to understand how to format your letter.
              Be specific about structure, tone, and what to include or exclude.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="name">Template Name</Label>
                <Input
                  id="name"
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder="e.g. Cardiology Clinic Letter"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="mode">Mode</Label>
                <Select value={formMode} onValueChange={(v: "consultation" | "dictation") => setFormMode(v)}>
                  <SelectTrigger id="mode">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="consultation">Consultation</SelectItem>
                    <SelectItem value="dictation">Dictation</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="description">Description (optional)</Label>
              <Input
                id="description"
                value={formDescription}
                onChange={(e) => setFormDescription(e.target.value)}
                placeholder="Short description of when to use this template"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="prompt">Prompt</Label>
              <Textarea
                id="prompt"
                value={formPrompt}
                onChange={(e) => setFormPrompt(e.target.value)}
                placeholder="You are a clinical documentation assistant. Format the transcript as..."
                rows={14}
                className="font-mono text-xs"
              />
              <p className="text-xs text-muted-foreground">
                Tip: include the output structure with headings, any rules about UK English /
                NHS terminology, and what to omit.
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setEditorOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => saveMutation.mutate()}
              disabled={saveMutation.isPending}
              className="gap-2"
            >
              {saveMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              Save Template
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete template?</AlertDialogTitle>
            <AlertDialogDescription>
              "{deleteTarget?.name}" will be permanently deleted. Recordings already generated with
              this template will not be affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
              className="bg-red-600 hover:bg-red-700"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default Templates;
