import { useEffect, useState } from "react";
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
import { Loader2, ShieldCheck, ShieldOff, Smartphone } from "lucide-react";
import { toast } from "sonner";

type Factor = { id: string; friendly_name?: string; status: string };

/**
 * Time-based one-time password (TOTP) two-factor authentication.
 *
 * Enrolment is a three-step exchange with the auth provider:
 *   1. enroll()          -> returns a QR code and a secret
 *   2. user scans it in an authenticator app
 *   3. challengeAndVerify() with the app's code -> factor becomes verified
 *
 * An unverified factor left behind by an abandoned enrolment would otherwise
 * accumulate, so it is cleaned up when the user cancels.
 */
const TwoFactorSettings = () => {
  const [factors, setFactors] = useState<Factor[]>([]);
  const [loading, setLoading] = useState(true);

  const [enrolling, setEnrolling] = useState(false);
  const [qr, setQr] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [factorId, setFactorId] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [removing, setRemoving] = useState(false);

  const verified = factors.filter((f) => f.status === "verified");
  const isEnabled = verified.length > 0;

  const refresh = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase.auth.mfa.listFactors();
      if (error) throw error;
      setFactors(((data?.all ?? []) as any[]).map((f) => ({
        id: f.id, friendly_name: f.friendly_name, status: f.status,
      })));
    } catch (e: any) {
      // Not fatal — the section simply shows as unavailable.
      console.warn("[mfa] listFactors failed:", e?.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void refresh(); }, []);

  const startEnrolment = async () => {
    setEnrolling(true);
    try {
      // Clear any half-finished factor from a previous abandoned attempt,
      // otherwise the provider rejects the new enrolment as a duplicate.
      const stale = factors.filter((f) => f.status !== "verified");
      for (const f of stale) {
        await supabase.auth.mfa.unenroll({ factorId: f.id }).catch(() => {});
      }

      const { data, error } = await supabase.auth.mfa.enroll({
        factorType: "totp",
        friendlyName: `NoteMD ${new Date().toISOString().slice(0, 10)}`,
      });
      if (error) throw error;

      setFactorId(data.id);
      setQr((data as any).totp?.qr_code ?? null);
      setSecret((data as any).totp?.secret ?? null);
    } catch (e: any) {
      toast.error(e?.message || "Could not start setup");
      setEnrolling(false);
    }
  };

  const cancelEnrolment = async () => {
    if (factorId) await supabase.auth.mfa.unenroll({ factorId }).catch(() => {});
    setEnrolling(false);
    setQr(null); setSecret(null); setFactorId(null); setCode("");
    void refresh();
  };

  const verify = async () => {
    if (!factorId || code.trim().length < 6) {
      toast.error("Enter the 6-digit code from your authenticator app");
      return;
    }
    setVerifying(true);
    try {
      const { error } = await supabase.auth.mfa.challengeAndVerify({
        factorId,
        code: code.trim(),
      });
      if (error) throw error;
      toast.success("Two-factor authentication is on");
      setEnrolling(false);
      setQr(null); setSecret(null); setFactorId(null); setCode("");
      await refresh();
    } catch (e: any) {
      toast.error(e?.message || "That code was not accepted. Try the next one.");
    } finally {
      setVerifying(false);
    }
  };

  const removeAll = async () => {
    setRemoving(true);
    try {
      for (const f of factors) {
        const { error } = await supabase.auth.mfa.unenroll({ factorId: f.id });
        if (error) throw error;
      }
      toast.success("Two-factor authentication turned off");
      await refresh();
    } catch (e: any) {
      toast.error(e?.message || "Could not turn it off");
    } finally {
      setRemoving(false);
      setRemoveOpen(false);
    }
  };

  return (
    <Card className="rounded-2xl border-border/60 shadow-[0_1px_3px_rgba(21,33,52,0.04)]">
      <CardHeader>
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <CardTitle>Two-factor authentication</CardTitle>
            <CardDescription>
              Require a code from your phone as well as your password. Strongly
              recommended for accounts holding patient data.
            </CardDescription>
          </div>
          {!loading && (
            <Badge
              variant="secondary"
              className={isEnabled
                ? "bg-success/15 text-success"
                : "bg-muted text-muted-foreground"}
            >
              {isEnabled ? "On" : "Off"}
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {loading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Checking…
          </div>
        )}

        {!loading && !isEnabled && !enrolling && (
          <Button onClick={startEnrolment} className="gap-2">
            <ShieldCheck className="h-4 w-4" />
            Turn on two-factor authentication
          </Button>
        )}

        {enrolling && (
          <div className="space-y-4">
            <div className="flex flex-col sm:flex-row gap-5 items-start">
              {qr && (
                <div className="rounded-xl border border-border/60 bg-white p-3 shrink-0">
                  {/* The provider returns the QR as an SVG data URI. */}
                  <img src={qr} alt="Two-factor setup QR code" className="h-40 w-40 block" />
                </div>
              )}
              <div className="space-y-3 min-w-0 flex-1">
                <div className="flex items-start gap-2 text-sm text-muted-foreground">
                  <Smartphone className="h-4 w-4 mt-0.5 shrink-0" />
                  <p>
                    Scan this with an authenticator app — Microsoft Authenticator,
                    Google Authenticator, 1Password or similar — then enter the
                    6-digit code it shows.
                  </p>
                </div>
                {secret && (
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">
                      Or enter this key manually
                    </Label>
                    <code className="block text-xs font-mono break-all rounded-md bg-muted px-2 py-1.5">
                      {secret}
                    </code>
                  </div>
                )}
                <div className="space-y-1.5">
                  <Label htmlFor="mfaCode">6-digit code</Label>
                  <Input
                    id="mfaCode"
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    placeholder="000000"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    className="font-mono tracking-widest max-w-[160px]"
                  />
                </div>
                <div className="flex gap-2">
                  <Button onClick={verify} disabled={verifying || code.length < 6} className="gap-2">
                    {verifying && <Loader2 className="h-4 w-4 animate-spin" />}
                    Verify and turn on
                  </Button>
                  <Button onClick={cancelEnrolment} variant="ghost">Cancel</Button>
                </div>
              </div>
            </div>
          </div>
        )}

        {!loading && isEnabled && !enrolling && (
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <p className="text-sm text-muted-foreground">
              You'll be asked for a code from your authenticator app each time you sign in.
            </p>
            <Button
              onClick={() => setRemoveOpen(true)}
              variant="outline"
              className="gap-2 text-destructive hover:text-destructive"
            >
              <ShieldOff className="h-4 w-4" />
              Turn off
            </Button>
          </div>
        )}
      </CardContent>

      <AlertDialog open={removeOpen} onOpenChange={setRemoveOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Turn off two-factor authentication?</AlertDialogTitle>
            <AlertDialogDescription>
              Your account will be protected by password alone. For an account with
              access to patient data this materially weakens its security.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it on</AlertDialogCancel>
            <AlertDialogAction
              onClick={removeAll}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {removing ? "Turning off…" : "Turn off"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
};

export default TwoFactorSettings;
