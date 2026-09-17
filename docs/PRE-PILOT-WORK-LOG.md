# NHS pre-pilot programme — work log

Tracks delivery against the client's ten-point scope of 15 September 2026.
The first $1,500 is the previously agreed security/assurance milestone; work
beyond it is recorded here with effort so it can be billed against the agreed
"extra hours" arrangement.

Status key: **done** · **in progress** · **blocked** (waiting on the client) ·
**not started**

---

## Progress

| # | Item | Status | Effort |
|---|------|--------|--------|
| 5a | Expanded audit trail | done | 0.9 d |
| 5b | Separate staging environment | done — project live, 19 migrations applied | 0.6 d |
| 5c | Cross-user / IDOR testing incl. secretary | done — 20 tests, 3 vulnerabilities found and fixed | 1.1 d |
| 1 | Azure OpenAI migration | not started | — |
| 3 | Deepgram unchanged (EU + `mip_opt_out`) | done — regression tests already in place | — |
| 4 | Identifier minimisation to AI providers | not started | — |
| 2 | Azure Communication Services email | not started | — |
| 6 | Draft/Reviewed workflow verification | **finding raised — see below** | 0.1 d |
| 7 | Wrong-patient / concurrency testing | not started | — |
| 8 | Remaining security and configuration | not started | — |
| 9 | Backups, recovery test, retention proposal | not started | — |
| 10 | Final documentation and evidence pack | not started | — |

**Effort to date: 2.7 d**

---

## Findings

### F-002 — Any account could grant itself access to any clinician's patient records

**Severity: critical.** Found 17 September 2026 by the IDOR suite. **Fixed.**

Secretary access is derived at query time from `profiles.clinician_id`:

    CREATE POLICY "Secretaries can view their clinician's letters"
      ON public.letters FOR SELECT
      USING (user_id = public.get_my_clinician_id());

and the only policy governing profile writes was:

    CREATE POLICY "Users can update their own profile"
      ON public.profiles FOR UPDATE USING (auth.uid() = user_id);

That restricts which *row* may be updated, not which *columns*. So any
authenticated account could set its own `clinician_id` to another clinician's
`user_id` and immediately read that clinician's letters, recordings and stored
audio — every patient record belonging to them, from a single UPDATE.

Confirmed against the live staging database, not inferred from the schema: an
unrelated account self-assigned and then read clinician A's letter.

Fixed in `20260917100000_lock_privileged_profile_columns.sql`. `role`,
`clinician_id` and `user_id` are no longer self-assignable, on UPDATE or on
INSERT. Legitimate secretary assignment is unaffected because
`manage-secretary` performs it with the service role.

### F-003 — Any account could promote itself to admin

**Severity: high.** Same root cause as F-002, same fix. `profiles.role` was
self-assignable; an ordinary account could set it to `admin`.

### F-004 — Audit entries could be attributed to another user

**Severity: high.** Consequence of F-002: having self-assigned as a
clinician's secretary, an account could log audit events attributed to that
clinician. Closed by the same fix — the attempt is now recorded with
`outcome = 'denied'` against the actor rather than the claimed subject.

### F-001 — A draft letter can be emailed and exported without clinician review

**Severity: high (clinical safety).** Raised 16 September 2026, during item 6.

The client's stated safety boundary is:

> AI generates draft → clinician reviews/edits → clinician explicitly approves
> → export/send. AI generation itself must never constitute clinician approval.

Two routes currently cross that boundary.

1. `send-letter-email` accepts any `letter_id` and sends it, regardless of the
   letter's status. It then sets the status to `exported`. A letter that has
   never left `draft` can therefore be emailed to a recipient and recorded as
   exported, with no clinician action in between.

2. `generate-letter` calls `send-letter-email` directly when the clinician has
   `auto_send_enabled` set. With that setting on, an AI-generated draft is
   emailed **immediately on generation** — the clinician does not see it first.

The audit trail now records `status_before_send` on every send, so the
condition is at least observable in production from this commit onward. The
behaviour itself is unchanged pending a decision, because closing it changes
what the auto-send feature does.

**Options**

| | Approach | Effect |
|---|---|---|
| A | Refuse to send a letter in `draft`; require `reviewed` first. Auto-send then only fires for letters the clinician has saved. | Closes the gap fully. Auto-send stops being automatic on generation. |
| B | Keep auto-send, but require the clinician to opt in per letter rather than as a standing profile setting. | Closes the gap; keeps a one-click path. |
| C | Leave as is and document it as an accepted risk in the DPIA. | No development. Likely to be raised by the penetration tester and by the Trust's clinical safety officer. |

Recommendation: **A**, with the auto-send setting relabelled so it is clear it
sends on review rather than on generation. This is the option that matches the
boundary the client has written down, and it is a small change now versus a
penetration-test finding later.

---

## Client actions outstanding

These block delivery and cannot be done from the codebase.

- **Confirm the staging project region is `eu-west-1`** (Settings → General).
  The residency commitment covers staging as well as production.
- **Apply the migrations to production.** Staging is up to date; production is
  serving code that writes audit events against columns it does not yet have.
  Audit writes fail soft, so nothing breaks, but the trail is not being kept:
  `./scripts/db-push.sh production`. This now also carries the F-002 fix.
- **Azure OpenAI resource** (item 1) — endpoint, deployment name, key and the
  confirmed region. Note that the audio/transcription models are not generally
  available in UK South; if the required model is only offered in the EU Data
  Zone, that needs confirming with the DPO before implementation, per the
  client's own instruction to prefer a UK regional deployment.
- **Azure Communication Services resource** (item 2) — data location, verified
  sending domain, connection string.
- **Deploys owed from the previous milestone** — `supabase db push`; deploy
  `deepgram-token`, `transcribe-audio`, `generate-letter`, `regenerate-letter`,
  `diagnostics-transcription`; delete the retired `transcribe-chunk` function;
  allow-list `/reset-password` under Authentication → URL Configuration.
- **Retired Google Cloud Run service** (item 8) — the US `medasr-service` needs
  deleting from the client's Google Cloud project.

---

## Decisions taken

- **Pre-authentication login failures are not written to our audit log.** An
  unauthenticated client has no write path into `processing_audit_log`, which
  is a deliberate property: a client that can write unauthenticated rows can
  forge them. Failed sign-in attempts are recorded by GoTrue in
  `auth.audit_log_entries` and that table is the evidence source for them.
  Failures after a session exists — a failed MFA challenge at aal1 — are in
  our own log.
- **Audit writes never fail a clinical action.** Losing a generated letter
  because the log was briefly unreachable is a worse outcome than a gap in the
  trail, and the gap is itself visible in the function logs.
