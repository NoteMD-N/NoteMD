/**
 * Single owner of any patient-identifiable data held in browser storage.
 *
 * Why this exists (UK GDPR Art. 32 — security of processing):
 *
 * The crash-recovery snapshot necessarily contains patient name, NHS number and
 * the clinical transcript. `localStorage` persists indefinitely — it survives
 * logout, browser restart and OS restart. On a shared clinical workstation that
 * means the next clinician to sign in could read the previous clinician's
 * patient data straight out of devtools.
 *
 * Two mitigations, both enforced here rather than at call sites:
 *
 *   1. Keys are namespaced by user id, so one account can never read a snapshot
 *      written by another.
 *   2. `purgeAllLocalPhi()` is called on sign-out, so PHI does not outlive the
 *      session on the device.
 *
 * localStorage is still the right store (sessionStorage would not survive the
 * tab close we are recovering from), so the lifecycle controls above are what
 * make it acceptable rather than the storage choice itself.
 */

/** Every PHI-bearing key we write is prefixed with this. */
const PHI_KEY_PREFIX = "notemd.phi.";

/** Snapshots older than this are treated as stale and discarded on read. */
export const RECOVERY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function keyFor(userId: string, name: string): string {
  return `${PHI_KEY_PREFIX}${userId}.${name}`;
}

export function readPhi<T>(userId: string, name: string): T | null {
  if (!userId) return null;
  try {
    const raw = localStorage.getItem(keyFor(userId, name));
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null; // corrupt or storage unavailable
  }
}

export function writePhi(userId: string, name: string, value: unknown): void {
  if (!userId) return; // never write PHI we cannot scope to an account
  try {
    localStorage.setItem(keyFor(userId, name), JSON.stringify(value));
  } catch {
    /* quota exceeded or private mode — recovery is best-effort */
  }
}

export function clearPhi(userId: string, name: string): void {
  if (!userId) return;
  try {
    localStorage.removeItem(keyFor(userId, name));
  } catch {
    /* ignore */
  }
}

/**
 * Remove every PHI key for every user on this device.
 *
 * Called on sign-out. Deliberately sweeps ALL users' keys, not just the one
 * signing out: on a shared workstation a previous session may have been ended
 * by closing the tab rather than signing out, leaving its snapshot behind.
 */
export function purgeAllLocalPhi(): void {
  try {
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PHI_KEY_PREFIX)) doomed.push(k);
    }
    doomed.forEach((k) => localStorage.removeItem(k));

    // Legacy un-namespaced key from before this module existed. Removing it
    // here cleans up devices that stored PHI under the old scheme.
    localStorage.removeItem("notemd.recording-recovery.v1");
  } catch {
    /* ignore */
  }
}

/** Discard any snapshot older than the retention window. */
export function isSnapshotFresh(savedAt: number | undefined): boolean {
  if (!savedAt) return false;
  return Date.now() - savedAt <= RECOVERY_MAX_AGE_MS;
}
