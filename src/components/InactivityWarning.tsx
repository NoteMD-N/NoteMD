import { useInactivity } from "@/hooks/useInactivityTimeout";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

/**
 * Warns before an idle session ends.
 *
 * A session that disappears without notice loses whatever was on screen and
 * leaves the clinician unsure whether their work saved. Announcing it gives
 * them a chance to keep it, and makes the timeout feel like a policy rather
 * than a fault.
 *
 * Only "Stay signed in" dismisses this — clicking elsewhere does not, because
 * the point of the timeout is a workstation nobody is attending.
 */
export const InactivityWarning = () => {
  const { warningSecondsLeft, staySignedIn, timeoutMinutes } = useInactivity();

  if (warningSecondsLeft === null) return null;

  return (
    <AlertDialog open>
      <AlertDialogContent onEscapeKeyDown={(e) => e.preventDefault()}>
        <AlertDialogHeader>
          <AlertDialogTitle>Still there?</AlertDialogTitle>
          <AlertDialogDescription>
            You'll be signed out in{" "}
            <strong>
              {warningSecondsLeft} second{warningSecondsLeft === 1 ? "" : "s"}
            </strong>{" "}
            because there's been no activity for {timeoutMinutes} minutes. Signing
            out clears patient information from this browser.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogAction onClick={staySignedIn}>Stay signed in</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

export default InactivityWarning;
