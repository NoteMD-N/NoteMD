# Retention architecture — proposal

For approval before implementation, as requested. Nothing here is built yet
and **no production retention setting has been changed.**

---

## 1. Correcting the starting premise

The request says:

> The previous technical review described transcripts and generated letters as
> being retained for 10 years. I do not want NoteMD automatically designed as
> the permanent authoritative clinical record.

Retention is **not** hard-coded, and has not been since 19 August 2026. It is
already column-driven, on `profiles`:

| Column | Default | Bounds |
| --- | --- | --- |
| `audio_retention_days` | **30** | 1–3650 |
| `transcript_retention_days` | 3650 | — |

So audio already expires after a month by default, not ten years. The 3650
figure applies to transcripts and letters, and it is a default rather than a
fixed period.

A daily `pg_cron` job (`notemd-audio-retention-purge`, 02:30 UTC) deletes
expired audio objects, blanks the stored path and writes an audit entry for
each deletion. It is active in both environments.

**This changes the size of the work considerably.** What is being asked for is
not a retention redesign; it is moving an existing setting from the account to
the organisation, and adding one deletion trigger. That is why this is a
proposal rather than a quotation for a redesign.

---

## 2. The actual gap: there is no organisation

The request is for retention "configurable at organisation/customer level".
The obstacle is that **NoteMD has no concept of an organisation.** The schema
has `profiles` with a `role` and an optional `clinician_id` for secretaries,
and nothing above that. Every setting is therefore per account.

That matters beyond retention. Without an organisation entity there is no
place to hang a Trust's policy for session timeout, audit retention, approved
email routing, or data-controller identity — all of which a pilot Trust will
eventually ask about.

### Proposed shape

    organisations
      id, name, ods_code (nullable), created_at
      audio_retention_days          default 30
      transcript_retention_days     default 3650
      letter_retention_days         default 3650
      delete_audio_on_export        default true
      inactivity_timeout_minutes    default 30

    profiles
      + organisation_id  -> organisations(id)

Resolution order becomes **organisation policy, falling back to the existing
per-account value, falling back to the built-in default.** Existing accounts
get a single-member organisation created from their current settings, so
nothing changes for anyone on migration day.

Only an organisation administrator may change organisation policy;
`organisation_id` joins `role` and `clinician_id` as a column an account
cannot set on itself (see F-002 — this is exactly the escalation route that
was closed on 17 September).

**Estimated effort: 2–3 days**, including the migration, the admin UI, RLS
policy updates and tests.

---

## 3. Deleting audio once the letter is approved and exported

Requested:

> Audio recording should be deleted once the letter is approved and exported.

This is straightforward to implement — the `letter.exported` transition
already exists and is audited — but it is **a clinical safety decision, not a
development one**, and I would want it recorded as such.

**The argument for:** audio is the most identifiable artefact NoteMD holds. A
recording carries the patient's voice, everything said in the room including
matters not clinically relevant, and often third-party voices. Deleting it at
the earliest safe moment is good data minimisation and materially reduces the
consequence of any breach.

**The argument against:** the audio is the only evidence of what was actually
said. If a letter is later disputed — the wrong medication, an omitted
finding, a misheard dose — the recording is what distinguishes a transcription
error from a clinical one. Deleting it on export removes the ability to
answer that question. It also removes the ability to re-transcribe if a
defect is found in the transcription path, which is not hypothetical: this
project has already shipped one bug where the wrong engine was silently used.

**Recommendation:** implement it as `delete_audio_on_export`, defaulting to
**off**, with a short configurable grace period (suggest 7 days after export)
rather than immediate deletion. That gives the minimisation benefit while
leaving a window in which a dispute or defect can still be investigated. The
Trust's Clinical Safety Officer should make the final call under DCB0160, and
the decision should be recorded in the hazard log either way.

**Estimated effort: 0.5 days** once the organisation table exists.

---

## 4. Deletion covering linked records and files

Requested:

> Please also ensure deletion processes appropriately cover linked
> records/files according to the configured policy.

Largely in place. `gdpr_erase_patient` already removes the letter, the
recording, the stored audio object and writes an audit entry, with a
`p_expected_count` guard so a mis-typed identifier cannot erase more than the
caller expected.

Two gaps to close:

- **Transcript and letter expiry is not enforced.** `transcript_retention_days`
  exists as a column but no scheduled job acts on it — only audio is purged.
  A transcript therefore persists indefinitely regardless of the setting.
- **Storage orphans.** If a `recordings` row is deleted directly, the audio
  object in storage is not removed with it. A periodic reconciliation should
  delete objects with no corresponding row.

**Estimated effort: 1 day.**

---

## 5. What retention cannot reach

Two limits should be stated in the DPIA rather than discovered later.

**Backups.** An erased record remains inside physical backups for up to 7
days. See `evidence/backup-configuration.md`.

**Exported correspondence.** Once a letter has been exported or emailed, the
copy in the Trust's clinical record or a recipient's mailbox is outside
NoteMD's control entirely. This is the intended workflow — NoteMD is not the
authoritative record — but it means "deletion from NoteMD" and "deletion of
the patient's data" are different statements, and the DPIA should say so.

---

## 6. Summary

| Item | Effort | Decision needed |
| --- | --- | --- |
| Organisation entity and policy resolution | 2–3 d | Approve the shape above |
| Delete audio on export | 0.5 d | **CSO decision** — recommend default off with a 7-day grace period |
| Transcript and letter expiry job | 0.5 d | None |
| Storage orphan reconciliation | 0.5 d | None |
| **Total** | **3.5–4.5 d** | |

No production retention setting will be changed until this is approved.
