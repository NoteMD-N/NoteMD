// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, screen } from "@testing-library/react";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * An unattended, still-authenticated browser on a shared clinical workstation
 * is the most ordinary way patient data reaches the wrong person, and it does
 * not look like a breach while it is happening.
 *
 * The timer itself is easy; the two behaviours worth testing are the ones that
 * make it safe to ship: that a recording in progress holds the session open,
 * and that a profile which cannot be read falls back to a timeout rather than
 * to no timeout.
 */

const signOut = vi.fn(async () => {});
const maybeSingle = vi.fn();

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "user-1" }, session: {}, loading: false, signOut }),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle }) }),
    }),
  },
}));

import { InactivityProvider, useInactivity } from "@/hooks/useInactivityTimeout";
import { InactivityWarning } from "@/components/InactivityWarning";

/** Drives the provider from inside, so the context is available. */
const Harness = ({ onReady }: { onReady?: (ctx: ReturnType<typeof useInactivity>) => void }) => {
  const ctx = useInactivity();
  onReady?.(ctx);
  return <div data-testid="warning">{ctx.warningSecondsLeft ?? "none"}</div>;
};

async function advance(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  signOut.mockClear();
  maybeSingle.mockResolvedValue({ data: { inactivity_timeout_minutes: 30 } });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("inactivity timeout", () => {
  it("signs out after the configured period of no activity", async () => {
    render(
      <InactivityProvider>
        <Harness />
      </InactivityProvider>,
    );
    await act(async () => {});

    await advance(29 * 60_000);
    expect(signOut).not.toHaveBeenCalled();

    await advance(2 * 60_000);
    expect(signOut).toHaveBeenCalledWith("inactivity");
  });

  it("warns before signing out rather than vanishing", async () => {
    render(
      <InactivityProvider>
        <Harness />
      </InactivityProvider>,
    );
    await act(async () => {});

    await advance(29 * 60_000 + 10_000);
    // A session that disappears silently loses whatever was on screen.
    expect(screen.getByTestId("warning").textContent).not.toBe("none");
    expect(signOut).not.toHaveBeenCalled();
  });

  it("does not sign out while a recording is in progress", async () => {
    // Speaking into a microphone produces no pointer or key events, so
    // without an explicit suspension a long consultation looks exactly like
    // an abandoned workstation. Logging the clinician out would destroy the
    // recording.
    let ctx: ReturnType<typeof useInactivity> | undefined;
    render(
      <InactivityProvider>
        <Harness onReady={(c) => (ctx = c)} />
      </InactivityProvider>,
    );
    await act(async () => {});

    let release: (() => void) | undefined;
    act(() => {
      release = ctx!.suspend("recording");
    });

    await advance(90 * 60_000);
    expect(signOut, "a recording must hold the session open").not.toHaveBeenCalled();

    // Once it ends, the full window starts again from that moment.
    act(() => release!());
    await advance(29 * 60_000);
    expect(signOut).not.toHaveBeenCalled();
    await advance(2 * 60_000);
    expect(signOut).toHaveBeenCalledWith("inactivity");
  });

  it("falls back to a timeout when the profile cannot be read", async () => {
    // A missing setting must never resolve to "never expire".
    maybeSingle.mockResolvedValue({ data: null });
    render(
      <InactivityProvider>
        <Harness />
      </InactivityProvider>,
    );
    await act(async () => {});

    await advance(31 * 60_000);
    expect(signOut).toHaveBeenCalledWith("inactivity");
  });

  it("honours a shorter organisation policy", async () => {
    maybeSingle.mockResolvedValue({ data: { inactivity_timeout_minutes: 5 } });
    render(
      <InactivityProvider>
        <Harness />
      </InactivityProvider>,
    );
    await act(async () => {});

    await advance(6 * 60_000);
    expect(signOut).toHaveBeenCalledWith("inactivity");
  });

  it("ignores incidental activity once the warning is showing", async () => {
    // The point of the timeout is a workstation nobody is attending; a stray
    // pointer event from someone walking past should not keep it signed in.
    render(
      <InactivityProvider>
        <Harness />
        <InactivityWarning />
      </InactivityProvider>,
    );
    await act(async () => {});

    await advance(29 * 60_000 + 10_000);
    expect(screen.getByTestId("warning").textContent).not.toBe("none");

    await act(async () => {
      window.dispatchEvent(new Event("pointermove"));
    });
    await advance(60_000);
    expect(signOut).toHaveBeenCalledWith("inactivity");
  });

  it("stays signed in when the user says so", async () => {
    let ctx: ReturnType<typeof useInactivity> | undefined;
    render(
      <InactivityProvider>
        <Harness onReady={(c) => (ctx = c)} />
      </InactivityProvider>,
    );
    await act(async () => {});

    await advance(29 * 60_000 + 10_000);
    act(() => ctx!.staySignedIn());

    await advance(20 * 60_000);
    expect(signOut).not.toHaveBeenCalled();
  });
});

describe("configuration", () => {
  const ROOT = join(__dirname, "../..");

  it("bounds the configurable range in the database", () => {
    const sql = readdirSync(join(ROOT, "supabase/migrations"))
      .filter((f) => f.endsWith(".sql"))
      .map((f) => readFileSync(join(ROOT, "supabase/migrations", f), "utf8"))
      .join("\n");
    // A Trust must not be able to configure the control away entirely, nor
    // set it so short the product is unusable.
    expect(sql).toMatch(/inactivity_timeout_minutes integer NOT NULL DEFAULT 30/);
    expect(sql).toMatch(/CHECK \(inactivity_timeout_minutes BETWEEN 5 AND 480\)/);
  });

  it("suspends the timer from the recorder", () => {
    const record = readFileSync(join(ROOT, "src/pages/Record.tsx"), "utf8");
    expect(record).toMatch(/suspendInactivity\("recording"\)/);
  });

  it("clears locally cached patient data on timeout", () => {
    // signOut() purges local PHI; the timeout must route through it rather
    // than calling supabase.auth.signOut directly.
    const hook = readFileSync(join(ROOT, "src/hooks/useInactivityTimeout.tsx"), "utf8");
    expect(hook).toMatch(/signOut\("inactivity"\)/);
    expect(hook).not.toMatch(/supabase\.auth\.signOut/);

    const auth = readFileSync(join(ROOT, "src/hooks/useAuth.tsx"), "utf8");
    expect(auth).toMatch(/purgeAllLocalPhi/);
  });
});
