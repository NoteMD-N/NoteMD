import { useCallback, useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import MfaChallenge from "@/components/MfaChallenge";

type Aal = "loading" | "satisfied" | "needs_challenge";

const Spinner = () => (
  <div className="flex min-h-screen items-center justify-center bg-background">
    <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
  </div>
);

/**
 * Gate on authentication AND, where the account has a verified second factor,
 * on assurance level.
 *
 * The provider reports two levels: the session's current level, and the level
 * the account requires. A password-only session on an account with TOTP
 * enrolled is aal1 where aal2 is required — that gap is what this component
 * closes. Enrolling a factor without this check would be cosmetic.
 */
const ProtectedRoute = ({ children }: { children: React.ReactNode }) => {
  const { user, loading } = useAuth();
  const [aal, setAal] = useState<Aal>("loading");

  const checkAal = useCallback(async () => {
    if (!user) return;
    try {
      const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      if (error) throw error;
      const { currentLevel, nextLevel } = data ?? {};
      // nextLevel is aal2 only when a verified factor exists on the account.
      setAal(nextLevel === "aal2" && currentLevel !== "aal2" ? "needs_challenge" : "satisfied");
    } catch (e) {
      // Fail open rather than locking everyone out if the check itself fails —
      // the session is still authenticated, and RLS still applies.
      console.warn("[auth] assurance level check failed:", e);
      setAal("satisfied");
    }
  }, [user]);

  useEffect(() => {
    if (loading) return;
    if (!user) { setAal("loading"); return; }
    void checkAal();
  }, [user, loading, checkAal]);

  if (loading) return <Spinner />;
  if (!user) return <Navigate to="/auth" replace />;
  if (aal === "loading") return <Spinner />;
  if (aal === "needs_challenge") return <MfaChallenge onVerified={checkAal} />;

  return <>{children}</>;
};

export default ProtectedRoute;
