import { describe, it, expect, beforeEach } from "vitest";
import {
  readPhi,
  writePhi,
  clearPhi,
  purgeAllLocalPhi,
  isSnapshotFresh,
  RECOVERY_MAX_AGE_MS,
} from "@/lib/local-phi";

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
