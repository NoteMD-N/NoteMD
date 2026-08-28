import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { BrandMark } from "@/components/BrandLogo";

/**
 * Second-factor gate.
 *
 * Signing in with a password gives assurance level aal1. An account with a
 * verified TOTP factor requires aal2, so this screen stands between a
 * password-only session and the application. Without it, enrolling a factor
 * would change nothing — the session would still reach the app at aal1.
 */
const MfaChallenge = ({ onVerified }: { onVerified: () => void }) => {
  const [code, setCode] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [factorId, setFactorId] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.auth.mfa.listFactors();
      const totp = (data?.totp ?? []).find((f: any) => f.status === "verified");
      if (totp) setFactorId(totp.id);
    })();
  }, []);

  const verify = async () => {
    if (!factorId || code.trim().length < 6) return;
    setVerifying(true);
    try {
      const { error } = await supabase.auth.mfa.challengeAndVerify({
        factorId,
        code: code.trim(),
      });
      if (error) throw error;
      onVerified();
    } catch (e: any) {
      toast.error(e?.message || "That code was not accepted. Try the next one.");
      setCode("");
    } finally {
      setVerifying(false);
    }
  };

  const signOut = async () => {
    await supabase.auth.signOut();
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <BrandMark className="h-10 w-10" />
          <div>
            <h1 className="font-heading text-xl font-bold tracking-tight text-foreground">
              Two-factor verification
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Enter the 6-digit code from your authenticator app.
            </p>
          </div>
        </div>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="challengeCode" className="sr-only">Authentication code</Label>
            <Input
              id="challengeCode"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              onKeyDown={(e) => { if (e.key === "Enter") void verify(); }}
              placeholder="000000"
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              className="text-center text-xl font-mono tracking-[0.4em] h-12"
            />
          </div>

          <Button
            onClick={verify}
            disabled={verifying || code.length < 6 || !factorId}
            className="w-full gap-2 h-11"
          >
            {verifying ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
            {verifying ? "Verifying…" : "Verify"}
          </Button>

          <button
            type="button"
            onClick={signOut}
            className="w-full text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            Sign in as a different user
          </button>
        </div>
      </div>
    </div>
  );
};

export default MfaChallenge;
