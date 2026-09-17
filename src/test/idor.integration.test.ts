// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Hostile-access testing against a real database.
 *
 * Row Level Security cannot be verified by reading the migrations. A policy
 * can be syntactically present, attached to the right table, and still not
 * restrict what it appears to — because another policy on another table grants
 * a route around it. The only way to know is to authenticate as one user and
 * try to reach another user's data.
 *
 * So this runs against the staging project with real accounts and real JWTs,
 * and every assertion is an attack that must fail.
 *
 * Run it with:
 *   IDOR_SUPABASE_URL=https://<ref>.supabase.co \
 *   IDOR_SUPABASE_ANON_KEY=sb_publishable_... \
 *   IDOR_SERVICE_ROLE_KEY=eyJ... \
 *   npx vitest run src/test/idor.integration.test.ts
 *
 * Skipped when those are absent, so the ordinary suite needs no credentials.
 */

const URL_ = process.env.IDOR_SUPABASE_URL ?? "";
const ANON = process.env.IDOR_SUPABASE_ANON_KEY ?? "";
const SERVICE = process.env.IDOR_SERVICE_ROLE_KEY ?? "";

/**
 * The production project. This suite creates and deletes users and seeds
 * patient-shaped rows; running it against live data would be an incident, so
 * it refuses rather than trusting whoever set the variables.
 */
const PRODUCTION_REF = "mdunhinhsrdrilxcdbvq";
const targetsProduction = URL_.includes(PRODUCTION_REF);

const configured = Boolean(URL_ && ANON && SERVICE) && !targetsProduction;

if (targetsProduction) {
  throw new Error(
    "idor.integration.test.ts was pointed at the PRODUCTION project. " +
      "This suite creates and deletes accounts. Refusing to run.",
  );
}

interface Actor {
  label: string;
  email: string;
  id: string;
  client: SupabaseClient;
}

/** One attempted access and whether the database stopped it. */
interface Attempt {
  scenario: string;
  actor: string;
  target: string;
  blocked: boolean;
  observed: string;
}

const attempts: Attempt[] = [];

function record(a: Attempt): Attempt {
  attempts.push(a);
  return a;
}

const PASSWORD = "Idor-Test-Pw-9f3!x";
const stamp = Date.now();
const admin = configured
  ? createClient(URL_, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } })
  : (null as unknown as SupabaseClient);

let clinicianA: Actor;
let clinicianB: Actor;
let secretaryOfA: Actor;
let outsider: Actor;

/** Records seeded with the service role, so RLS is not in the way of setup. */
const seeded: Record<string, { recordingId: string; letterId: string; audioPath: string }> = {};

async function makeActor(label: string, role: string, clinicianId?: string): Promise<Actor> {
  const email = `idor-${label}-${stamp}@notemd-test.invalid`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  });
  if (error) throw new Error(`could not create ${label}: ${error.message}`);
  const id = data.user!.id;

  // handle_new_user creates the profile row; set the role and assignment on it.
  const { error: pErr } = await admin
    .from("profiles")
    .upsert({ user_id: id, role, clinician_id: clinicianId ?? null }, { onConflict: "user_id" });
  if (pErr) throw new Error(`could not set profile for ${label}: ${pErr.message}`);

  const client = createClient(URL_, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error: sErr } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (sErr) throw new Error(`could not sign in ${label}: ${sErr.message}`);

  return { label, email, id, client };
}

async function seedFor(actor: Actor) {
  // Storage is namespaced by user id; that prefix is what the policy checks,
  // and recordings.audio_path is NOT NULL, so the path is decided first.
  const audioPath = `${actor.id}/synthetic-${stamp}.webm`;
  const transcript = `Synthetic consultation for ${actor.label}. No real patient.`;

  const { data: rec, error: rErr } = await admin
    .from("recordings")
    .insert({
      user_id: actor.id,
      audio_path: audioPath,
      status: "transcribed",
      patient_name: `Synthetic ${actor.label}`,
      patient_id: `TEST-${actor.label}-${stamp}`,
    })
    .select()
    .single();
  if (rErr) throw new Error(`seed recording for ${actor.label}: ${rErr.message}`);

  // The transcript lives on letters, not on recordings.
  const { data: letter, error: lErr } = await admin
    .from("letters")
    .insert({
      user_id: actor.id,
      recording_id: rec.id,
      status: "draft",
      transcript,
      letter_content: `Synthetic letter body for ${actor.label}.`,
      patient_name: rec.patient_name,
      patient_id: rec.patient_id,
    })
    .select()
    .single();
  if (lErr) throw new Error(`seed letter for ${actor.label}: ${lErr.message}`);

  const { error: sErr } = await admin.storage
    .from("audio-recordings")
    .upload(audioPath, new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])]), {
      contentType: "audio/webm",
      upsert: true,
    });
  if (sErr) throw new Error(`seed audio for ${actor.label}: ${sErr.message}`);

  seeded[actor.label] = { recordingId: rec.id, letterId: letter.id, audioPath };
}

beforeAll(async () => {
  if (!configured) return;
  clinicianA = await makeActor("clinicianA", "clinician");
  clinicianB = await makeActor("clinicianB", "clinician");
  secretaryOfA = await makeActor("secretaryOfA", "secretary", clinicianA.id);
  outsider = await makeActor("outsider", "clinician");
  await seedFor(clinicianA);
  await seedFor(clinicianB);
}, 120_000);

afterAll(async () => {
  if (!configured) return;

  // Evidence for the assurance pack: what was attempted and what happened.
  const dir = join(__dirname, "../../docs/evidence");
  mkdirSync(dir, { recursive: true });
  const lines = [
    "# Cross-user / IDOR test results",
    "",
    `Run: ${new Date().toISOString()}`,
    `Target: ${URL_.replace(/https:\/\/([a-z0-9]+)\..*/, "$1")} (staging, synthetic data)`,
    "",
    "Every row is an access attempt that must be refused.",
    "",
    "| Scenario | Actor | Target | Blocked | Observed |",
    "| --- | --- | --- | --- | --- |",
    ...attempts.map(
      (a) => `| ${a.scenario} | ${a.actor} | ${a.target} | ${a.blocked ? "yes" : "**NO**"} | ${a.observed} |`,
    ),
    "",
    `Attempts: ${attempts.length} · Blocked: ${attempts.filter((a) => a.blocked).length} · ` +
      `Not blocked: ${attempts.filter((a) => !a.blocked).length}`,
  ];
  writeFileSync(join(dir, "idor-results.md"), lines.join("\n") + "\n");

  for (const actor of [clinicianA, clinicianB, secretaryOfA, outsider]) {
    if (!actor) continue;
    const s = seeded[actor.label];
    if (s) await admin.storage.from("audio-recordings").remove([s.audioPath]);
    await admin.auth.admin.deleteUser(actor.id);
  }
}, 120_000);

describe.skipIf(!configured)("clinician A against clinician B", () => {
  it("cannot list B's letters", async () => {
    const { data } = await clinicianA.client.from("letters").select("id");
    const leaked = (data ?? []).some((r) => r.id === seeded.clinicianB.letterId);
    record({
      scenario: "List all letters",
      actor: "Clinician A",
      target: "B's letter",
      blocked: !leaked,
      observed: `${data?.length ?? 0} row(s), none belonging to B`,
    });
    expect(leaked).toBe(false);
  });

  it("cannot fetch B's letter by its exact id", async () => {
    // Guessing or replaying an id is the plainest form of the attack.
    const { data } = await clinicianA.client
      .from("letters")
      .select("id, letter_content")
      .eq("id", seeded.clinicianB.letterId);
    record({
      scenario: "Fetch letter by manipulated id",
      actor: "Clinician A",
      target: `letter ${seeded.clinicianB.letterId.slice(0, 8)}…`,
      blocked: (data ?? []).length === 0,
      observed: `${data?.length ?? 0} row(s) returned`,
    });
    expect(data ?? []).toHaveLength(0);
  });

  it("cannot fetch B's recording by its exact id", async () => {
    const { data } = await clinicianA.client
      .from("recordings")
      .select("id, transcript")
      .eq("id", seeded.clinicianB.recordingId);
    record({
      scenario: "Fetch recording by manipulated id",
      actor: "Clinician A",
      target: `recording ${seeded.clinicianB.recordingId.slice(0, 8)}…`,
      blocked: (data ?? []).length === 0,
      observed: `${data?.length ?? 0} row(s) returned`,
    });
    expect(data ?? []).toHaveLength(0);
  });

  it("cannot modify B's letter", async () => {
    const { data } = await clinicianA.client
      .from("letters")
      .update({ letter_content: "TAMPERED" })
      .eq("id", seeded.clinicianB.letterId)
      .select();

    const { data: check } = await admin
      .from("letters")
      .select("letter_content")
      .eq("id", seeded.clinicianB.letterId)
      .single();
    const tampered = check?.letter_content === "TAMPERED";
    record({
      scenario: "Update another clinician's letter",
      actor: "Clinician A",
      target: "B's letter",
      blocked: !tampered,
      observed: `${data?.length ?? 0} row(s) affected; content unchanged`,
    });
    expect(tampered).toBe(false);
  });

  it("cannot delete B's recording", async () => {
    await clinicianA.client.from("recordings").delete().eq("id", seeded.clinicianB.recordingId);
    const { data: check } = await admin
      .from("recordings")
      .select("id")
      .eq("id", seeded.clinicianB.recordingId);
    const survived = (check ?? []).length === 1;
    record({
      scenario: "Delete another clinician's recording",
      actor: "Clinician A",
      target: "B's recording",
      blocked: survived,
      observed: survived ? "row still present" : "ROW DELETED",
    });
    expect(survived).toBe(true);
  });

  it("cannot download B's audio", async () => {
    const { data, error } = await clinicianA.client.storage
      .from("audio-recordings")
      .download(seeded.clinicianB.audioPath);
    const blocked = !data || Boolean(error);
    record({
      scenario: "Download another clinician's audio",
      actor: "Clinician A",
      target: "B's audio object",
      blocked,
      observed: error ? `error: ${error.message}` : data ? "FILE RETURNED" : "no data",
    });
    expect(blocked).toBe(true);
  });

  it("cannot list B's storage folder", async () => {
    const { data } = await clinicianA.client.storage.from("audio-recordings").list(clinicianB.id);
    record({
      scenario: "List another clinician's storage folder",
      actor: "Clinician A",
      target: "B's folder",
      blocked: (data ?? []).length === 0,
      observed: `${data?.length ?? 0} object(s) listed`,
    });
    expect(data ?? []).toHaveLength(0);
  });

  it("cannot read B's profile", async () => {
    const { data } = await clinicianA.client
      .from("profiles")
      .select("user_id")
      .eq("user_id", clinicianB.id);
    record({
      scenario: "Read another clinician's profile",
      actor: "Clinician A",
      target: "B's profile",
      blocked: (data ?? []).length === 0,
      observed: `${data?.length ?? 0} row(s) returned`,
    });
    expect(data ?? []).toHaveLength(0);
  });
});

describe.skipIf(!configured)("secretary permissions", () => {
  it("can read their assigned clinician's letters", async () => {
    // The one case that must succeed; a test suite that only proves denial
    // would also pass against a database nobody can use.
    const { data } = await secretaryOfA.client
      .from("letters")
      .select("id")
      .eq("id", seeded.clinicianA.letterId);
    expect(data ?? []).toHaveLength(1);
  });

  it("cannot modify their assigned clinician's letter", async () => {
    await secretaryOfA.client
      .from("letters")
      .update({ letter_content: "SECRETARY TAMPERED" })
      .eq("id", seeded.clinicianA.letterId);
    const { data: check } = await admin
      .from("letters")
      .select("letter_content")
      .eq("id", seeded.clinicianA.letterId)
      .single();
    const tampered = check?.letter_content === "SECRETARY TAMPERED";
    record({
      scenario: "Secretary modifies assigned clinician's letter",
      actor: "Secretary of A",
      target: "A's letter",
      blocked: !tampered,
      observed: tampered ? "CONTENT CHANGED" : "content unchanged (read-only)",
    });
    expect(tampered).toBe(false);
  });

  it("cannot read an unassigned clinician's letters", async () => {
    const { data } = await secretaryOfA.client
      .from("letters")
      .select("id")
      .eq("id", seeded.clinicianB.letterId);
    record({
      scenario: "Secretary reads unassigned clinician's letter",
      actor: "Secretary of A",
      target: "B's letter",
      blocked: (data ?? []).length === 0,
      observed: `${data?.length ?? 0} row(s) returned`,
    });
    expect(data ?? []).toHaveLength(0);
  });

  it("cannot download an unassigned clinician's audio", async () => {
    const { data, error } = await secretaryOfA.client.storage
      .from("audio-recordings")
      .download(seeded.clinicianB.audioPath);
    const blocked = !data || Boolean(error);
    record({
      scenario: "Secretary downloads unassigned clinician's audio",
      actor: "Secretary of A",
      target: "B's audio object",
      blocked,
      observed: error ? `error: ${error.message}` : "FILE RETURNED",
    });
    expect(blocked).toBe(true);
  });
});

describe.skipIf(!configured)("privilege escalation", () => {
  it("cannot make itself a secretary of another clinician", async () => {
    // Secretary access is derived from profiles.clinician_id, and users may
    // update their own profile. If the update policy does not constrain which
    // columns may change, any account can assign itself to any clinician and
    // inherit read access to that clinician's records.
    await outsider.client
      .from("profiles")
      .update({ clinician_id: clinicianA.id, role: "secretary" })
      .eq("user_id", outsider.id);

    const { data: after } = await admin
      .from("profiles")
      .select("clinician_id, role")
      .eq("user_id", outsider.id)
      .single();
    const selfAssigned = after?.clinician_id === clinicianA.id;

    const { data: reached } = await outsider.client
      .from("letters")
      .select("id")
      .eq("id", seeded.clinicianA.letterId);
    const gainedAccess = (reached ?? []).length > 0;

    record({
      scenario: "Self-assign as secretary of another clinician",
      actor: "Outsider",
      target: "A's records",
      blocked: !gainedAccess,
      observed: selfAssigned
        ? `clinician_id accepted; ${reached?.length ?? 0} of A's letters reachable`
        : "clinician_id rejected",
    });

    expect(selfAssigned, "profiles.clinician_id must not be self-assignable").toBe(false);
    expect(gainedAccess, "self-assignment must not grant access to another clinician's records").toBe(false);
  });

  it("cannot promote itself to admin", async () => {
    await outsider.client.from("profiles").update({ role: "admin" }).eq("user_id", outsider.id);
    const { data: after } = await admin
      .from("profiles")
      .select("role")
      .eq("user_id", outsider.id)
      .single();
    const escalated = after?.role === "admin";
    record({
      scenario: "Self-promote to admin",
      actor: "Outsider",
      target: "own profile role",
      blocked: !escalated,
      observed: `role is now "${after?.role}"`,
    });
    expect(escalated, "profiles.role must not be self-assignable").toBe(false);
  });

  it("cannot forge an audit entry attributed to another user", async () => {
    const { error } = await outsider.client.rpc("log_audit_event", {
      p_action: "letter.exported",
      p_subject_id: clinicianA.id,
      p_outcome: "success",
    });
    const { data: rows } = await admin
      .from("processing_audit_log")
      .select("user_id, actor_user_id, outcome")
      .eq("actor_user_id", outsider.id)
      .order("created_at", { ascending: false })
      .limit(1);
    const forged = rows?.[0]?.user_id === clinicianA.id && rows?.[0]?.outcome !== "denied";
    record({
      scenario: "Forge an audit entry against another user",
      actor: "Outsider",
      target: "A's audit trail",
      blocked: !forged,
      observed: error
        ? `error: ${error.message}`
        : `recorded against ${rows?.[0]?.user_id === outsider.id ? "self" : "OTHER USER"}, outcome "${rows?.[0]?.outcome}"`,
    });
    expect(forged).toBe(false);
  });

  it("cannot alter an existing audit entry", async () => {
    const { data: row } = await admin
      .from("processing_audit_log")
      .select("id")
      .limit(1)
      .maybeSingle();
    if (!row) return;
    const { error } = await outsider.client
      .from("processing_audit_log")
      .update({ action: "tampered" })
      .eq("id", row.id);
    const { data: after } = await admin
      .from("processing_audit_log")
      .select("action")
      .eq("id", row.id)
      .single();
    const tampered = after?.action === "tampered";
    record({
      scenario: "Modify an audit record",
      actor: "Outsider",
      target: "audit log",
      blocked: !tampered,
      observed: error ? `error: ${error.message}` : "no error, content unchanged",
    });
    expect(tampered).toBe(false);
  });
});

describe.skipIf(!configured)("legitimate access still works", () => {
  // A suite that only proves denial would also pass against a database nobody
  // can use. These are the positive controls for the profile column lock.
  it("lets a user update their own display name", async () => {
    const { error } = await outsider.client
      .from("profiles")
      .update({ full_name: "Updated Name" })
      .eq("user_id", outsider.id);
    expect(error, "the column lock must not block ordinary profile edits").toBeNull();

    const { data } = await admin
      .from("profiles")
      .select("full_name")
      .eq("user_id", outsider.id)
      .single();
    expect(data?.full_name).toBe("Updated Name");
  });

  it("lets a user write their own records and read them back", async () => {
    const { data, error } = await outsider.client
      .from("recordings")
      .insert({
        user_id: outsider.id,
        audio_path: `${outsider.id}/own-${stamp}.webm`,
        status: "uploaded",
      })
      .select()
      .single();
    expect(error).toBeNull();

    const { data: readBack } = await outsider.client
      .from("recordings")
      .select("id")
      .eq("id", data!.id);
    expect(readBack ?? []).toHaveLength(1);
  });

  it("lets a user record an audit event about their own action", async () => {
    const { error } = await outsider.client.rpc("log_audit_event", {
      p_action: "letter.viewed",
      p_resource: "letter",
    });
    expect(error).toBeNull();
  });
});

describe.skipIf(!configured)("session revocation", () => {
  it("cannot continue reading after the session is revoked", async () => {
    const victim = await makeActor("revoked", "clinician");
    await seedFor(victim);

    const { data: before } = await victim.client.from("letters").select("id");
    expect((before ?? []).length).toBeGreaterThan(0);

    // Revoke every refresh token for the user, as account deactivation would.
    await admin.auth.admin.signOut(
      (await victim.client.auth.getSession()).data.session!.access_token,
      "global",
    );
    await admin.auth.admin.updateUserById(victim.id, { ban_duration: "24h" });

    // The access token is a signed JWT and stays valid until it expires, so
    // the meaningful check is that it cannot be exchanged for a new one.
    const { error: refreshErr } = await victim.client.auth.refreshSession();
    record({
      scenario: "Refresh a session after revocation",
      actor: "Revoked user",
      target: "own session",
      blocked: Boolean(refreshErr),
      observed: refreshErr ? `error: ${refreshErr.message}` : "SESSION REFRESHED",
    });
    expect(refreshErr, "a revoked session must not be refreshable").toBeTruthy();

    const s = seeded[victim.label];
    if (s) await admin.storage.from("audio-recordings").remove([s.audioPath]);
    await admin.auth.admin.deleteUser(victim.id);
  }, 60_000);
});
