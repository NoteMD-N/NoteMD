import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Save, FileText, Copy } from "lucide-react";
import type { Tables } from "@/integrations/supabase/types";

type Letter = Tables<"letters">;

const LetterView = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [letter, setLetter] = useState<Letter | null>(null);
  const [editedContent, setEditedContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

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

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="bg-background min-h-full">
      <div className="max-w-3xl mx-auto p-6 space-y-6">
        {/* Action bar */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h2 className="font-heading text-xl font-bold text-foreground">Letter</h2>
            <Badge variant="secondary">{letter?.status}</Badge>
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
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default LetterView;
