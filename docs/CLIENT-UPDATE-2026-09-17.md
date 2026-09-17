# NoteMD — pre-pilot security work, progress update

17 September 2026

Hi Mohamed,

An update on the ten-point scope. Seven of the ten items are complete, and the
security testing you commissioned has found five issues — including one
serious one — all of which are now fixed. Details below.

---

## 1. The security testing found a critical vulnerability, before the pen test

This is the most important thing in this update.

**Any authenticated account could read any clinician's patient records.** Not
a theoretical weakness — a single database update, and one account could see
another clinician's letters, recordings and stored audio in full.

The cause was a gap between two pieces of access control that each looked
correct in isolation. Secretary access is worked out at query time from a
field on the user's own profile (`clinician_id`). The rule governing profile
edits restricted *which row* a user could change, but not *which columns*. So
any account could point its own `clinician_id` at a clinician and immediately
inherit read access to that clinician's entire record set.

Two related problems came from the same gap: an account could also make itself
an administrator, and could write audit entries attributed to another
clinician.

**All three are fixed and the fix is live in production.** `role`,
`clinician_id` and `user_id` are no longer self-assignable. Legitimate
secretary assignment is unaffected because that runs through a privileged
server function.

Two points worth drawing out:

- **This could not have been found by reading the code.** Each individual
  policy is correct; the hole exists only in the interaction between them. It
  was found by authenticating as one user and attempting to reach another
  user's data against a live database — which is exactly the cross-user/IDOR
  testing in your point 5.
- **It was found before the penetration test rather than during it.** Had it
  gone the other way it would have been a critical finding in a report sent to
  a Trust's information governance team, with remediation under time pressure.

The test suite that found it now runs 24 hostile access attempts — including
manipulated record identifiers, storage access, secretary permissions against
assigned and unassigned clinicians, privilege escalation, audit tampering and
access after account revocation. All 24 are refused. It produces a written
evidence file on every run for your assurance pack.

---

## 2. A second finding you should know about, because it changes behaviour

**A letter could be emailed before any clinician had read it.**

Your stated safety boundary is that AI generates a draft, the clinician
reviews and approves, and only then does the letter leave the system. Two
routes crossed that line:

1. The email function accepted any letter regardless of its status, then
   marked it as exported. A letter that had never left `draft` could be sent
   to a recipient and recorded as sent, with no clinician action in between.
2. Where a clinician had **auto-send** switched on, the system emailed the
   letter *the moment the AI produced it*. Those clinicians never saw the
   letter before it went out.

Both are now closed. Sending is refused for anything that has not been
reviewed, and letter generation no longer sends at all.

**The change your users will notice:** auto-send now fires when the clinician
saves their review, rather than on generation. Anyone currently relying on
auto-send will find they have to open and save each letter — at which point it
sends automatically, as before. This is the boundary you specified, but it is
a visible change to their working day and is worth telling them about rather
than letting them discover it.

---

## 3. Three further findings, all fixed

**Patient data was being written into server logs.** Every server function
ended with a line that logged the error when something failed. That reads as
harmless. In fact, when the database rejects a write, it returns the rejected
row as part of the error — so a failed letter insert wrote the patient's name,
NHS number and transcript into retained logs. This was not hypothetical: the
autosave problem you reported earlier this year was producing exactly this
class of rejection, repeatedly, in production. Errors are now reduced to a
code and a truncated message before logging, with the row data dropped
outright.

**Patient names and NHS numbers were being sent to the AI provider
unnecessarily.** The letter prompt included them as a header, and the model
does nothing with them except copy them into its output. They are now replaced
with placeholder tokens and reinstated on our own server afterwards. To be
clear about what this is and is not: this is data minimisation, not
anonymisation — the transcript still goes to the provider and a name spoken
aloud is inherent to the audio. But the structured identifiers no longer leave
our systems. This is a lighter-touch version of the identifier system you
declined, and deliberately avoids the wrong-patient risk you were concerned
about: there is no matching step, because substitution happens on a single
letter using values read from that letter's own record.

**Dependency vulnerabilities.** 25 advisories at the start of this work, 13 of
them in code that ships to the browser. Now **zero** in shipped code, with
four remaining in build tooling that never reaches a user.

---

## 4. Completed against your numbering

| # | Item | Status |
| --- | --- | --- |
| 3 | Deepgram retained, EU endpoint, `mip_opt_out` | Complete, with automated regression tests |
| 4 | Identifier minimisation to AI providers | Complete |
| 5 | Audit trail, staging environment, IDOR testing | Complete — see below |
| 6 | Draft/Reviewed workflow verification | Complete — finding fixed |
| 8 | Remaining security and configuration | Mostly complete — see below |
| 9 | Backups, recovery test, retention proposal | Complete |
| 1, 2 | Azure OpenAI and Azure Communication Services | Blocked — needs your Azure resources |
| 7 | Wrong-patient / concurrency testing | Next |
| 10 | Final documentation and evidence pack | After the above |

**Point 5 — the agreed security milestone.** The audit trail now records who
did what, against which record, when, and with what outcome. Three properties
are enforced by the database rather than by convention: the actor and the
subject are recorded separately, so a secretary acting on a clinician's record
is properly attributable; the log cannot be edited or deleted by anyone,
including our own server credentials; and clinical content cannot enter it —
an attempt to write a transcript into an audit entry is rejected by the
database.

A fully separate staging environment is live, in the same region as
production, with its own database, storage and credentials. Development and
testing no longer run against the production clinical database.

**Point 8.** Complete: dependency scanning, security response headers
(including Content Security Policy and HSTS), session and logout behaviour,
a configurable inactivity timeout, rate limiting on sensitive endpoints, and
confirmation that clinical content is absent from logs. Outstanding: the
production access register and the documented key-rotation approach, which
need your input on who currently has access; and deletion of the retired
Google Cloud Run service, which is in your Google Cloud account.

One result from the headers work is worth noting for the DPIA. The browser
streams consultation audio directly to the transcription provider. The
Content Security Policy now names only the EU endpoint, so **EU residency for
transcription is enforced in the browser itself** — if anything ever pointed
the stream at a non-EU region the connection would be refused rather than
silently leaving the EEA. This has been confirmed by observation, not just
configured.

**Point 9.** Backups are daily, retained seven days, and stored in West EU
(Ireland) — the same region as the database, so they create no transfer
outside the EEA. More importantly, a restore has been *rehearsed* rather than
assumed: both clinical tables were deleted entirely in staging and recovered
from backup, with row counts, a content checksum and the links between letters
and recordings all verified identical. A backup that has never been restored is
a hypothesis.

Two things for the DPIA that are easy to leave implicit: an erased record
remains inside backups for up to seven days before ageing out; and once a
letter has been exported, the copy in the Trust's record or a recipient's
mailbox is outside NoteMD's control entirely.

---

## 5. Decisions I need from you

**The retention proposal.** I have written this up rather than building it, as
you asked. One correction to the premise: retention is **not** hard-coded at
ten years and has not been since August — it is already configurable, audio
already defaults to thirty days, and a scheduled job enforces it. The actual
gap is that NoteMD has no concept of an organisation at all, so every setting
is per user account. That is what needs building, and it is a smaller piece of
work than a retention redesign. Estimated 3.5–4.5 days.

**One item in it is a clinical safety decision, not a development one.** You
asked for audio to be deleted once a letter is approved and exported. I would
recommend making that configurable and defaulting it to *off*, with a short
grace period, rather than deleting immediately. The reason: the recording is
the only evidence of what was actually said. If a letter is later disputed —
a wrong dose, an omitted finding — the audio is what distinguishes a
transcription error from a clinical one. That trade-off should be recorded by
the Clinical Safety Officer in the hazard log, not settled by me.

**Point-in-time recovery.** Please confirm from the Supabase dashboard whether
PITR is enabled on production. Without it the recovery point objective is up
to 24 hours; with it, typically two minutes. This is a paid add-on and the
answer belongs in the evidence pack either way.

---

## 6. What I need from you to continue

- **Azure OpenAI** — endpoint, deployment name, key and the confirmed region.
  Note that the audio and transcription models are generally not available in
  UK South. If the model you need is only offered in the EU Data Zone, that
  needs confirming with your DPO before I implement it, since your instruction
  was to prefer a UK regional deployment.
- **Azure Communication Services** — please note the **data location is fixed
  at resource creation and cannot be changed afterwards**. If it is created in
  the United States the only remedy is deleting and recreating it, and
  re-verifying any sender domains. It needs to be UK or Europe.
- **Deepgram** — as you asked, production should move to a NoteMD-owned
  account. Please create the account and two keys, staging and production. I
  would verify the EU endpoint against the new key on staging first, then
  switch production during a quiet period, because revoking the existing key
  would interrupt any dictation in progress.
- **Production access** — who currently has administrative access to Supabase,
  Render, Deepgram and production secrets, so I can complete the access
  register.
- **Retired Google Cloud Run service** — needs deleting from your Google Cloud
  account.

---

## 7. Effort

Six and a half days to date against the agreed $1,500 milestone, which covered
the audit trail, staging environment and IDOR testing. The remaining items —
wrong-patient and concurrency testing, the two Azure migrations, and the final
documentation and evidence pack — are the larger part of what is left.

I will keep working through the list and send a consolidated note on hours
before the feature freeze, so there are no surprises. Nothing here changes the
sequence you set out: development, internal review, automated testing, final
documentation, freeze, then the independent penetration test.

Happy to talk any of this through.

Chris
