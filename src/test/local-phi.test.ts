import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import { readPhi, writePhi, clearPhi, purgeAllLocalPhi, isSnapshotFresh, RECOVERY_MAX_AGE_MS, listPhiSlots, tabId } from "@/lib/local-phi";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";

const SNAPSHOT = {
  savedAt: Date.now(),
  patient_name: "John Smith",
  patient_id: "943 476 5919",
  transcript: "Right-sided headache with visual aura.",
};

beforeEach(() => {
  localStorage.clear();
});

describe("PHI storage isolation (GDPR Art. 32)", () => {
  it("round-trips a snapshot for the owning user", () => {
    writePhi(USER_A, "recording-recovery", SNAPSHOT);
    expect(readPhi(USER_A, "recording-recovery")).toEqual(SNAPSHOT);
  });

  it("never leaks one clinician's snapshot to another", () => {
    // The shared-workstation scenario.
    writePhi(USER_A, "recording-recovery", SNAPSHOT);
    expect(readPhi(USER_B, "recording-recovery")).toBeNull();
  });

  it("refuses to write PHI it cannot scope to an account", () => {
    writePhi("", "recording-recovery", SNAPSHOT);
    // Nothing should have been persisted at all.
    expect(localStorage.length).toBe(0);
  });

  it("returns null rather than throwing on corrupt data", () => {
    localStorage.setItem(`notemd.phi.${USER_A}.recording-recovery`, "{not json");
    expect(readPhi(USER_A, "recording-recovery")).toBeNull();
  });

  it("clears only the targeted user's slot", () => {
    writePhi(USER_A, "recording-recovery", SNAPSHOT);
    writePhi(USER_B, "recording-recovery", SNAPSHOT);
    clearPhi(USER_A, "recording-recovery");
    expect(readPhi(USER_A, "recording-recovery")).toBeNull();
    expect(readPhi(USER_B, "recording-recovery")).toEqual(SNAPSHOT);
  });
});

describe("purgeAllLocalPhi — sign-out must not leave PHI on the device", () => {
  it("removes every user's PHI, not just the one signing out", () => {
    writePhi(USER_A, "recording-recovery", SNAPSHOT);
    writePhi(USER_B, "recording-recovery", SNAPSHOT);
    purgeAllLocalPhi();
    expect(readPhi(USER_A, "recording-recovery")).toBeNull();
    expect(readPhi(USER_B, "recording-recovery")).toBeNull();
  });

  it("removes the legacy un-namespaced key from older builds", () => {
    localStorage.setItem(
      "notemd.recording-recovery.v1",
      JSON.stringify(SNAPSHOT),
    );
    purgeAllLocalPhi();
    expect(localStorage.getItem("notemd.recording-recovery.v1")).toBeNull();
  });

  it("leaves non-PHI application keys untouched", () => {
    localStorage.setItem("theme", "dark");
    writePhi(USER_A, "recording-recovery", SNAPSHOT);
    purgeAllLocalPhi();
    expect(localStorage.getItem("theme")).toBe("dark");
  });

  it("leaves no residual PHI keys behind at all", () => {
    writePhi(USER_A, "recording-recovery", SNAPSHOT);
    purgeAllLocalPhi();
    const remaining = Object.keys(localStorage).filter((k) =>
      k.startsWith("notemd.phi."),
    );
    expect(remaining).toEqual([]);
  });
});

describe("isSnapshotFresh — storage limitation", () => {
  it("accepts a snapshot saved just now", () => {
    expect(isSnapshotFresh(Date.now())).toBe(true);
  });

  it("rejects one older than the retention window", () => {
    expect(isSnapshotFresh(Date.now() - RECOVERY_MAX_AGE_MS - 1000)).toBe(false);
  });

  it("rejects a missing timestamp", () => {
    expect(isSnapshotFresh(undefined)).toBe(false);
    expect(isSnapshotFresh(0)).toBe(false);
  });
});

describe("recovery slots are per tab, not per user", () => {
  /**
   * The bug this prevents: localStorage is shared by every tab on the origin,
   * so a snapshot slot named only after the user is one slot that all tabs
   * write to. Two consultations open side by side overwrote each other — one
   * session was lost outright, and the survivor was offered back in the other
   * tab, under a different patient's name.
   */
  const USER = "11111111-1111-1111-1111-111111111111";
  const PREFIX = "recording-recovery";

  it("keeps two concurrent tabs from overwriting each other", () => {
    // Two tabs, two patients, interleaved writes — as happens when a clinician
    // has one consultation open and opens a second.
    writePhi(USER, `${PREFIX}.tab-a`, {
      savedAt: Date.now(),
      patient_name: "Alice Adams",
      transcript: "Alice attended with chest pain.",
    });
    writePhi(USER, `${PREFIX}.tab-b`, {
      savedAt: Date.now(),
      patient_name: "Bob Barker",
      transcript: "Bob attended with a cough.",
    });

    const a = readPhi<{ patient_name: string }>(USER, `${PREFIX}.tab-a`);
    const b = readPhi<{ patient_name: string }>(USER, `${PREFIX}.tab-b`);

    expect(a?.patient_name).toBe("Alice Adams");
    expect(b?.patient_name).toBe("Bob Barker");
  });

  it("lists a user's slots newest first so the freshest is recoverable", () => {
    writePhi(USER, `${PREFIX}.old`, { savedAt: 1000, transcript: "older" });
    writePhi(USER, `${PREFIX}.new`, { savedAt: 9000, transcript: "newer" });

    const slots = listPhiSlots<{ savedAt: number; transcript: string }>(USER, PREFIX);
    expect(slots.length).toBeGreaterThanOrEqual(2);
    expect(slots[0].value.savedAt).toBeGreaterThan(slots[1].value.savedAt);
    expect(slots[0].slot.startsWith(PREFIX)).toBe(true);
  });

  it("never lists another user's slots", () => {
    const other = "22222222-2222-2222-2222-222222222222";
    writePhi(other, `${PREFIX}.tab-x`, {
      savedAt: Date.now(),
      patient_name: "Someone Else",
      transcript: "not ours",
    });
    const mine = listPhiSlots<{ savedAt?: number; patient_name?: string }>(USER, PREFIX);
    expect(mine.every((s) => s.value.patient_name !== "Someone Else")).toBe(true);
  });

  it("gives each tab a stable identifier that survives a reload", () => {
    const first = tabId();
    expect(first).toBeTruthy();
    // Same tab, later call — sessionStorage persists across a reload.
    expect(tabId()).toBe(first);
  });

  it("names the recorder's slot after the tab", () => {
    // The tests above exercise the storage layer, which would have accepted a
    // per-tab name before this fix too. What actually regressed the behaviour
    // was Record.tsx using one fixed slot name for every tab, so that is what
    // is asserted here.
    const record = readFileSync(join(__dirname, "../pages/Record.tsx"), "utf8");
    expect(record).toMatch(/RECOVERY_SLOT = `\$\{RECOVERY_PREFIX\}\.\$\{tabId\(\)\}`/);
    // And the plain, shared name must not be used as a slot anywhere.
    expect(record).not.toMatch(/RECOVERY_SLOT = "recording-recovery"/);
  });

  it("purges every tab's slot on sign-out", () => {
    writePhi(USER, `${PREFIX}.tab-a`, { savedAt: Date.now(), transcript: "a" });
    writePhi(USER, `${PREFIX}.tab-b`, { savedAt: Date.now(), transcript: "b" });
    purgeAllLocalPhi();
    expect(listPhiSlots(USER, PREFIX)).toEqual([]);
  });
});
