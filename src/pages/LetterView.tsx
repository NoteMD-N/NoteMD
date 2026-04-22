import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SelectGroup,
  SelectLabel,
} from "@/components/ui/select";
import { toast } from "sonner";
import {
  Save,
  FileText,
  Copy,
  Sparkles,
  Loader2,
  LayoutTemplate,
  User,
  IdCard,
} from "lucide-react";
import type { Tables } from "@/integrations/supabase/types";

type Letter = Tables<"letters">;
type Template = Tables<"templates">;

const QUICK_PROMPTS = [
  "Make it more formal",
  "Make it more concise",
  "Expand the history section",
  "Add a safety-netting paragraph",
  "Rewrite in discharge summary format",
];

const LetterView = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [letter, setLetter] = useState<Letter | null>(null);
  const [editedContent, setEditedContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  // Regenerate panel state
  const [instructions, setInstructions] = useState("");
  const [regenTemplateId, setRegenTemplateId] = useState<string>("keep");
  const [regenerating, setRegenerating] = useState(false);
  const [templates, setTemplates] = useState<Template[]>([]);

  useEffect(() => {
    if (!id) return;
    supabase
      .from("letters")
      .select("*")
      .eq("id", id)
      .single()
      .then(({ data, error }) => {
        if (error || !data) {
          toast.error("Letter not found");
          navigate("/dashboard");
          return;
        }
        setLetter(data);
        setEditedContent(data.letter_content || "");
        setLoading(false);
      });

    // Load templates for the "change template" dropdown
    supabase
      .from("templates")
      .select("*")
      .order("is_preset", { ascending: false })
      .order("name")
      .then(({ data }) => {
        if (data) setTemplates(data);
      });
  }, [id, navigate]);

  const handleSave = async () => {
    if (!letter) return;
    setSaving(true);
    const { error } = await supabase
      .from("letters")
      .update({ letter_content: editedContent, status: "reviewed" })
      .eq("id", letter.id);
    if (error) {
      toast.error("Failed to save");
    } else {
      toast.success("Letter saved");
      setLetter({ ...letter, letter_content: editedContent, status: "reviewed" });
    }
    setSaving(false);
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(editedContent);
    toast.success("Copied to clipboard");
  };

  const handleRegenerate = async (overrideInstructions?: string) => {
    const toSend = overrideInstructions ?? instructions;
    if (!letter || !toSend.trim()) return;
    setRegenerating(true);

    try {
      const { data, error } = await supabase.functions.invoke("regenerate-letter", {
        body: {
          letter_id: letter.id,
          instructions: toSend.trim(),
          template_id: regenTemplateId !== "keep" ? regenTemplateId : undefined,
        },
      });

      if (error) throw error;
      if (data?.letter_content) {
        setEditedContent(data.letter_content);
        setLetter({ ...letter, letter_content: data.letter_content, status: "draft" });
        toast.success("Letter regenerated");
        setInstructions("");
      }
    } catch (err: any) {
      toast.error(err.message || "Failed to regenerate letter");
    } finally {
      setRegenerating(false);
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="bg-background min-h-full">
      <div className="max-w-4xl mx-auto p-6 space-y-6">
        {/* Action bar */}
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3 flex-wrap">
            <h2 className="font-heading text-xl font-bold text-foreground">Letter</h2>
            <Badge variant="secondary">{letter?.status}</Badge>
            {letter?.patient_name && (
              <Badge variant="outline" className="gap-1">
                <User className="h-3 w-3" />
                {letter.patient_name}
              </Badge>
            )}
            {letter?.patient_id && (
              <Badge variant="outline" className="gap-1">
                <IdCard className="h-3 w-3" />
                {letter.patient_id}
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button onClick={handleCopy} variant="outline" size="sm" className="gap-2">
              <Copy className="h-4 w-4" />
              Copy
            </Button>
            <Button onClick={handleSave} size="sm" disabled={saving} className="gap-2">
              <Save className="h-4 w-4" />
              {saving ? "Saving..." : "Save"}
            </Button>
          </div>
        </div>

        {/* Transcript */}
        {letter?.transcript && (
          <Card className="shadow-card">
            <CardHeader className="pb-2">
              <CardTitle className="font-heading text-sm text-muted-foreground flex items-center gap-2">
                <FileText className="h-4 w-4" />
                Transcript
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-foreground whitespace-pre-wrap leading-relaxed">
                {letter.transcript}
              </p>
            </CardContent>
          </Card>
        )}

        {/* Editable Letter */}
        <Card className="shadow-elevated">
          <CardHeader className="pb-2">
            <CardTitle className="font-heading text-sm text-muted-foreground">
              Generated Letter
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Textarea
              value={editedContent}
              onChange={(e) => setEditedContent(e.target.value)}
              className="min-h-[500px] font-body text-sm leading-relaxed resize-y"
              disabled={regenerating}
            />
          </CardContent>
        </Card>

        {/* Regenerate with instructions */}
        <Card className="shadow-card border-primary/20">
          <CardHeader className="pb-3">
            <CardTitle className="font-heading text-sm flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" />
              Ask AI for Changes
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              Describe what you'd like to change, or pick a template to rewrite in a different
              format.
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            {/* Quick prompts */}
            <div className="flex flex-wrap gap-2">
              {QUICK_PROMPTS.map((p) => (
                <button
                  key={p}
                  onClick={() => handleRegenerate(p)}
                  disabled={regenerating}
                  className="px-3 py-1.5 rounded-full text-xs border border-border bg-background hover:bg-muted transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {p}
                </button>
              ))}
            </div>

            {/* Template override */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                <LayoutTemplate className="h-3.5 w-3.5" />
                Rewrite using a different template (optional)
              </label>
              <Select
                value={regenTemplateId}
                onValueChange={setRegenTemplateId}
                disabled={regenerating}
              >
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="keep">Keep current template</SelectItem>
                  <SelectGroup>
                    <SelectLabel>My Templates</SelectLabel>
                    {templates
                      .filter((t) => !t.is_preset)
                      .map((t) => (
                        <SelectItem key={t.id} value={t.id}>
                          {t.name}
                        </SelectItem>
                      ))}
                  </SelectGroup>
                  <SelectGroup>
                    <SelectLabel>Presets</SelectLabel>
                    {templates
                      .filter((t) => t.is_preset)
                      .map((t) => (
                        <SelectItem key={t.id} value={t.id}>
                          {t.name}
                        </SelectItem>
                      ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>

            {/* Custom instructions */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">
                Custom instructions
              </label>
              <Textarea
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                placeholder="e.g. Remove the examination section. Add a paragraph mentioning follow-up in 6 weeks. Rewrite in plainer language for the patient."
                rows={3}
                className="text-sm"
                disabled={regenerating}
              />
            </div>

            <Button
              onClick={() => handleRegenerate()}
              disabled={regenerating || (!instructions.trim() && regenTemplateId === "keep")}
              className="gap-2 w-full sm:w-auto"
            >
              {regenerating ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className="h-4 w-4" />
              )}
              {regenerating ? "Regenerating..." : "Apply Changes"}
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default LetterView;
