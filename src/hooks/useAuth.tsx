import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { User, Session } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { purgeAllLocalPhi } from "@/lib/local-phi";
import { AUDIT_ACTIONS, logAudit } from "@/lib/audit";

interface AuthContextType {
  user: User | null;
  session: Session | null;
  loading: boolean;
  /**
   * Signs out, recording the event first.
   *
   * Order matters: the audit write is authenticated as the departing user, so
   * it has to happen while the session still exists. Call this rather than
   * supabase.auth.signOut() directly, or the logout leaves no trace.
   */
  signOut: (reason?: "user" | "inactivity" | "revoked") => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  session: null,
  loading: true,
  signOut: async () => {},
});

export const useAuth = () => useContext(AuthContext);

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  // onAuthStateChange fires SIGNED_IN on token refresh and on restoring a
  // stored session, not only on a real sign-in. Auditing the raw event would
  // record a login every time a tab regained focus, so the transition from
  // "no user" to "a user" is what we treat as a login.
  const previousUserId = useRef<string | null>(null);

  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      // GDPR Art. 32: patient-identifiable data must not outlive the session on
      // the device. Clinical workstations are routinely shared, so any locally
      // cached PHI (the crash-recovery snapshot) is purged on sign-out.
      if (event === "SIGNED_OUT" || !session) {
        purgeAllLocalPhi();
      }
      const nextUserId = session?.user?.id ?? null;
      if (nextUserId && previousUserId.current !== nextUserId) {
        void logAudit({ action: AUDIT_ACTIONS.LOGIN, detail: { event } });
      }
      previousUserId.current = nextUserId;

      setSession(session);
      setUser(session?.user ?? null);
      setLoading(false);
    });

    supabase.auth.getSession().then(({ data: { session } }) => {
      previousUserId.current = session?.user?.id ?? null;
      setSession(session);
      setUser(session?.user ?? null);
      setLoading(false);
    });

    return () => subscription.unsubscribe();
  }, []);

  const signOut = async (reason: "user" | "inactivity" | "revoked" = "user") => {
    await logAudit({
      action: reason === "inactivity" ? AUDIT_ACTIONS.SESSION_TIMEOUT : AUDIT_ACTIONS.LOGOUT,
      detail: { reason },
    });
    await supabase.auth.signOut();
  };

  return (
    <AuthContext.Provider value={{ user, session, loading, signOut }}>
      {children}
    </AuthContext.Provider>
  );
};
