import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";

/**
 * Ends an idle session and clears locally cached patient data.
 *
 * Clinical workstations are shared and frequently walked away from. An
 * unattended, still-authenticated browser is the most ordinary way patient
 * data is disclosed to the wrong person, and it does not look like a breach
 * while it is happening.
 *
 * Two details matter more than the timer itself:
 *
 *  - A recording in progress suspends the countdown. Dictating is not idling,
 *    and logging a clinician out mid-consultation would destroy clinical work
 *    and teach them to distrust the product. Activity events do not fire while
 *    someone is simply speaking, so the recorder says so explicitly.
 *
 *  - There is a warning before the timeout, not just a logout. A session that
 *    vanishes silently loses unsaved edits; one that announces itself can be
 *    kept alive with a click.
 */

const WARNING_SECONDS = 60;

/** Events that count as the user still being present. */
const ACTIVITY_EVENTS = [
  "mousedown",
  "keydown",
  "touchstart",
  "scroll",
  "pointermove",
] as const;

interface InactivityContextValue {
  /**
   * Suspends the countdown while a long non-interactive task runs — recording
   * a consultation, principally. Returns a function that resumes it.
   */
  suspend: (reason: string) => () => void;
  /** Resets the countdown without a DOM event, for programmatic activity. */
  markActivity: () => void;
  /** Seconds remaining once the warning is showing; null otherwise. */
  warningSecondsLeft: number | null;
  /** Dismisses the warning and restarts the countdown. */
  staySignedIn: () => void;
  timeoutMinutes: number;
}

const InactivityContext = createContext<InactivityContextValue>({
  suspend: () => () => {},
  markActivity: () => {},
  warningSecondsLeft: null,
  staySignedIn: () => {},
  timeoutMinutes: 30,
});

export const useInactivity = () => useContext(InactivityContext);

export const InactivityProvider = ({ children }: { children: ReactNode }) => {
  const { user, signOut } = useAuth();
  const [timeoutMinutes, setTimeoutMinutes] = useState(30);
  const [warningSecondsLeft, setWarningSecondsLeft] = useState<number | null>(null);

  const lastActivity = useRef(Date.now());
  const suspensions = useRef(new Set<string>());
  const signingOut = useRef(false);

  // The configured policy for this account. Falls back to 30 minutes if the
  // profile cannot be read — a missing setting must not mean "never expire".
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    supabase
      .from("profiles")
      .select("inactivity_timeout_minutes")
      .eq("user_id", user.id)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled) return;
        const configured = Number(data?.inactivity_timeout_minutes);
        setTimeoutMinutes(Number.isFinite(configured) && configured > 0 ? configured : 30);
      });
    return () => {
      cancelled = true;
    };
  }, [user]);

  const markActivity = useCallback(() => {
    lastActivity.current = Date.now();
    setWarningSecondsLeft(null);
  }, []);

  const suspend = useCallback((reason: string) => {
    suspensions.current.add(reason);
    lastActivity.current = Date.now();
    return () => {
      suspensions.current.delete(reason);
      // Resuming counts as activity: the clinician has just finished doing
      // something, so they should get the full window from here.
      lastActivity.current = Date.now();
    };
  }, []);

  const staySignedIn = useCallback(() => {
    markActivity();
  }, [markActivity]);

  useEffect(() => {
    if (!user) return;

    const onActivity = () => {
      // While the warning is showing, only an explicit choice dismisses it.
      // A stray pointer event from a passer-by should not keep a shared
      // workstation signed in.
      if (warningSecondsLeft !== null) return;
      lastActivity.current = Date.now();
    };

    for (const event of ACTIVITY_EVENTS) {
      window.addEventListener(event, onActivity, { passive: true });
    }
    return () => {
      for (const event of ACTIVITY_EVENTS) {
        window.removeEventListener(event, onActivity);
      }
    };
  }, [user, warningSecondsLeft]);

  useEffect(() => {
    if (!user) return;

    const timeoutMs = timeoutMinutes * 60_000;
    const warnAtMs = Math.max(timeoutMs - WARNING_SECONDS * 1000, timeoutMs / 2);

    const tick = window.setInterval(() => {
      if (suspensions.current.size > 0) {
        lastActivity.current = Date.now();
        setWarningSecondsLeft(null);
        return;
      }

      const idleFor = Date.now() - lastActivity.current;

      if (idleFor >= timeoutMs) {
        if (signingOut.current) return;
        signingOut.current = true;
        setWarningSecondsLeft(null);
        // signOut purges locally cached patient data and records the event
        // while the session still exists to authenticate the write.
        void signOut("inactivity");
        return;
      }

      setWarningSecondsLeft(
        idleFor >= warnAtMs ? Math.max(0, Math.ceil((timeoutMs - idleFor) / 1000)) : null,
      );
    }, 1000);

    return () => window.clearInterval(tick);
  }, [user, timeoutMinutes, signOut]);

  // A fresh sign-in starts a fresh window.
  useEffect(() => {
    lastActivity.current = Date.now();
    signingOut.current = false;
    setWarningSecondsLeft(null);
  }, [user?.id]);

  return (
    <InactivityContext.Provider
      value={{ suspend, markActivity, warningSecondsLeft, staySignedIn, timeoutMinutes }}
    >
      {children}
    </InactivityContext.Provider>
  );
};
