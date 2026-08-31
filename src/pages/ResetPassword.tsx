import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Loader2, ShieldCheck } from "lucide-react";
import { BrandMark } from "@/components/BrandLogo";

/**
 * Completes a password reset.
 *
 * The emailed link returns the user here with a recovery session already
 * established by the auth client, so this page only needs to collect and set
 * the new password. If no recovery session is present the form is not shown —
 * otherwise the page would appear to work for anyone who navigated to it.
 */
const ResetPassword = () => {
  const navigate = useNavigate();
  const [ready, setReady] = useState<"checking" | "ok" | "invalid">("checking");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    // A recovery link produces a session; without one there is nothing to reset.
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY" || session) setReady("ok");
    });
    supabase.auth.getSession().then(({ data }) => {
      setReady(data.session ? "ok" : "invalid");
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < 8) {
      toast.error("Use at least 8 characters");
      return;
    }
    if (password !== confirm) {
      toast.error("The passwords do not match");
      return;
    }
    setSaving(true);
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      toast.success("Password updated. You're signed in.");
      navigate("/dashboard", { replace: true });
    } catch (err: any) {
      toast.error(err?.message || "Could not update the password");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <BrandMark className="h-10 w-10" />
          <h1 className="font-heading text-xl font-bold tracking-tight text-foreground">
            Set a new password
          </h1>
        </div>

        {ready === "checking" && (
          <div className="flex justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        )}

        {ready === "invalid" && (
          <div className="space-y-3 text-center">
            <p className="text-sm text-muted-foreground">
              This reset link is invalid or has expired. Request a new one from the
              sign-in page.
            </p>
            <Button variant="outline" onClick={() => navigate("/auth")} className="w-full">
              Back to sign in
            </Button>
          </div>
        )}

        {ready === "ok" && (
          <form onSubmit={submit} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="newPw">New password</Label>
              <Input
                id="newPw"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                minLength={8}
                autoFocus
                required
                className="h-11"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="confirmPw">Confirm new password</Label>
              <Input
                id="confirmPw"
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="••••••••"
                minLength={8}
                required
                className="h-11"
              />
            </div>
            <Button type="submit" disabled={saving} className="w-full h-11 gap-2">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
              {saving ? "Saving…" : "Set password"}
            </Button>
          </form>
        )}
      </div>
    </div>
  );
};

export default ResetPassword;
