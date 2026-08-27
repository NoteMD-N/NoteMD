# NoteMD — Technical Architecture & Data Protection Evidence

**Prepared:** 26 August 2026
**Purpose:** Evidence pack for DPIA, DSPT, DTAC and DCB0129 clinical safety work.
**Scope:** Production configuration as committed. Items marked **(B)** are stated
from configuration and need confirming against the live dashboards.

> This is a technical review by the development team. It is not legal advice and
> does not itself constitute a DPIA. A DPO must sign off the lawful basis,
> Article 9 condition, and transfer assessments.

## Status key

| | Meaning |
|---|---|
| **A** | Implemented and tested |
| **B** | Implemented, requires verification against live config |
| **C** | Not yet implemented |
| **D** | Requires action by NoteMD/provider, not development |

---

## 1. System architecture and data flow

### 1.1 Components

| Layer | Technology | Region |
|---|---|---|
| Frontend | React 18 / TypeScript SPA, static bundle | Render **(B — region to confirm)** |
| Authentication | Supabase Auth (GoTrue), JWT | `eu-west-1` Ireland |
| Backend/API | Supabase Edge Functions (Deno), 11 functions | `eu-west-1` Ireland |
| Database | Supabase PostgreSQL 15 | `eu-west-1` Ireland |
| Audio storage | Supabase Storage, private bucket `audio-recordings` | `eu-west-1` Ireland |
| Real-time transcription | Deepgram streaming API | `eu-central-1` Frankfurt **(A — verified)** |
| Batch transcription | OpenAI `gpt-4o-transcribe` | Global **(C — EU pending)** |
| Letter generation | OpenAI `gpt-4o` / `gpt-4o-mini` | Global **(C — EU pending)** |
| Email delivery | Resend | **(B — region to confirm)** |
| Billing | Stripe | Global |
| Legacy ASR (unused) | Google Cloud Run + Hugging Face model | `us-east4` Virginia **(C — decommission)** |

### 1.2 Primary data flow — consultation

```
Clinician browser
  |
  |-- (1) Sign in ------------------> Supabase Auth (eu-west-1)  -> JWT
  |
  |-- (2) Microphone capture (local, in memory)
  |
  |-- (3) Request streaming token --> Edge Fn deepgram-token (eu-west-1)
  |                                     returns short-lived key + EU endpoint
  |
  |-- (4) Audio stream -------------> Deepgram wss api.eu.deepgram.com
  |         (direct browser -> vendor)  (eu-central-1 Frankfurt)
  |                                     <- interim + final transcript
  |
  |-- (5) Transcript autosave ------> Supabase Postgres (eu-west-1)
  |         every ~15s, draft status
  |
  |-- (6) Clinician reviews/edits transcript on screen
  |
  |-- (7) Generate letter ----------> Edge Fn generate-letter (eu-west-1)
  |         audio uploaded to Supabase Storage (eu-west-1)
  |                                     |
  |                                     |-- transcript + patient identifiers
  |                                     |     -> OpenAI api.openai.com (GLOBAL)
  |                                     |     <- generated letter
  |                                     |
  |                                     |-- letter persisted -> Postgres (eu-west-1)
  |
  |-- (8) Letter displayed to clinician
  |
  |-- (9) Optional: email ----------> Edge Fn send-letter-email -> Resend
```

### 1.3 Primary data flow — dictation (Enhanced engine)

Deepgram is **not** used. Audio is captured in ~10s segments, each uploaded to
Supabase Storage and transcribed by OpenAI, with text appended to the on-screen
transcript. Letter generation then proceeds as step (7) above.

### 1.4 Transcript integrity control

Any transcript displayed on the review screen is marked authoritative and sent
with `transcript_source: "client"`. The server will not re-run speech recognition
over a reviewed transcript. This guarantees the letter is generated from exactly
the words the clinician read and approved. **(A — unit tested across all
mode/engine combinations.)**

---

## 2. Data inventory

| Data | Stored where | Retention | Deletion |
|---|---|---|---|
| Patient audio | Supabase Storage, private bucket, `{user_id}/` prefix | **30 days**, per-clinician configurable | Automatic nightly purge `gdpr_purge_expired_audio()` **(A)** |
| Audio segments (dictation) | Same bucket, `{user_id}/segments/` | Same 30-day policy | Same purge **(B — confirm segments matched by purge query)** |
| Transcripts | Postgres `letters.transcript` | 10 years default (NHS record retention) | Manual, or `gdpr_erase_user()` **(A)** |
| Generated letters | Postgres `letters.letter_content` | 10 years default | As above **(A)** |
| Patient identifiers (name, NHS number) | Postgres `recordings` + `letters` | With parent record | Cascade on record delete **(A)** |
| Clinician profile | Postgres `profiles` | Life of account | `gdpr_erase_user()` **(A)** |
| Account/login | Supabase Auth `auth.users` | Life of account | Requires admin API call **(C)** |
| Session tokens | Browser `localStorage` | Until logout/expiry | Cleared on sign-out **(A)** |
| Crash-recovery snapshot (transcript + identifiers) | Browser `localStorage`, namespaced per user | 24h max | Purged on sign-out **(A)** |
| IP / device | Supabase platform logs | Supabase default | Platform-managed **(B)** |
| Application logs | Supabase Edge Function logs | Supabase default | Platform-managed **(B)** |
| Processing audit log | Postgres `processing_audit_log`, append-only | Indefinite | Retained deliberately for accountability **(A)** |
| Backups | Supabase managed PITR/daily | Plan-dependent | **(B — confirm plan and window)** |
| Billing | Stripe (clinician name/email/payment only — **no patient data**) | Stripe policy | Stripe-managed **(D)** |
| Analytics/telemetry | **None** — no analytics SDK is present **(A — verified)** | n/a | n/a |

---

## 3. Data residency

### 3.1 Confirmed

| Provider | Region | Evidence |
|---|---|---|
| **Supabase** (DB, storage, auth, functions) | `eu-west-1` Ireland | Project configuration **(A)** |
| **Deepgram** | `eu-central-1` Frankfurt | In-app check returned HTTP 200 from `api.eu.deepgram.com`, 24 Aug 2026 **(A)** |

### 3.2 Outstanding

| Provider | Current | Required action |
|---|---|---|
| **OpenAI** | Global (`api.openai.com`) | **(D)** EU-resident project + Zero Data Retention. Application already supports this via `OPENAI_API_BASE` — one environment variable once the account is enabled. |
| **Resend** | Unconfirmed | **(D)** Switch to EU region. Letters/transcripts are emailed, so this carries patient data. |
| **Render** | Unconfirmed | **(B)** Static frontend only — **no patient data at rest**. Move to Frankfurt for tidiness. |
| **MedASR / Cloud Run** | `us-east4` Virginia | **(C)** Currently unused. Recommend deletion; `medasr-service/deploy-eu.sh` provided if it is to be retained in `europe-west2`. |
| **Google Fonts** | Google CDN (US) | **(C)** See §5.3 — receives clinician IP addresses. |

### 3.3 Can patient data leave the UK/EEA?

**Yes — currently via OpenAI only.** Transcripts, patient identifiers and (for
dictation) audio are sent to `api.openai.com`. All storage at rest remains in the
EU. This is the single outstanding residency gap and closes when the EU-resident
OpenAI project is enabled.

Hugging Face receives **no patient data** — see §8.4.

---

## 4. Data minimisation and retention

| Artefact | Rule | Status |
|---|---|---|
| Audio | Auto-deleted after 30 days (configurable 1–3650) | **A** |
| Transcripts / letters | Retained per NHS record retention | **A** |
| Audio after transcription | *Not* deleted immediately — retained for the window above | **D — policy decision** |
| Temporary files | None written to disk server-side; audio is streamed in memory | **A** |
| Browser storage | Purged on sign-out | **A** |
| Logs | Supabase platform retention | **B** |
| Backups | Deleted data may persist in backups until they roll off | **B** |

The request states audio should ideally be deleted immediately after
transcription. That is a one-line change to the retention default, but it
removes the ability to regenerate a letter or audit a transcript against source
audio. **This is a clinical-safety trade-off for the client to decide.**

---

## 5. Logging review

### 5.1 Fixed during this review

The `transcribe-chunk` function logged the first 80 characters of every
transcript to server logs. It was unreferenced by the application but remained a
deployed, authenticated endpoint. **Removed from the repository — it must also be
deleted in the Supabase dashboard (D).**

### 5.2 Current state **(A)**

No function logs transcripts, letters or patient identifiers. Logging is limited
to character counts, HTTP status codes, provider names and timings.

### 5.3 Residual findings **(C)**

1. **Third-party error bodies are logged.** Failed calls log up to 500 characters
   of the vendor's error response (`body.slice(0, 500)`). A vendor that echoes
   submitted content in an error could place clinical text in logs. Low
   likelihood, non-zero. *Recommend redaction before logging.*
2. **Google Fonts.** `index.html` loads fonts from Google's CDN, transmitting
   every clinician's IP address to Google in the US on each page load. Not
   patient data, but it is personal data, and a German court has found this
   unlawful without consent. *Recommend self-hosting the fonts — removes a US
   third party entirely.*

---

## 6. Authentication and access control

| Control | Status |
|---|---|
| Supabase Auth, email + password, bcrypt | **A** |
| JWT sessions, auto-refresh | **A** |
| RLS enabled on **all six** tables | **A — verified** |
| Per-user isolation via `auth.uid() = user_id` on every table | **A** |
| Storage isolation by `{user_id}/` folder prefix | **A** |
| Secretary delegated access, scoped via `get_my_clinician_id()` | **A** |
| Audit log readable only by its owner; no client write path | **A** |
| Password change (signed in) | **A** |
| **Password reset ("forgot password")** | **C — not implemented** |
| **MFA** | **C — not implemented.** Supabase supports TOTP; requires build work. |
| Account revocation | **B — via Supabase dashboard only, no in-app flow** |
| Session timeout / idle lock | **C** |

### 6.1 Cross-user access evidence

Isolation is enforced in Postgres, not application code, so it cannot be bypassed
by a malformed client request. Automated evidence currently covers browser-side
isolation (`src/test/local-phi.test.ts` proves one clinician cannot read
another's cached data). **Database-level cross-user tests against a live
instance are (C)** and are the strongest single addition for DTAC evidence.

---

## 7. Encryption and secrets

| Control | Status |
|---|---|
| TLS 1.2+ on all connections (app, API, vendors) | **A** |
| Encryption at rest — database and storage | **A — Supabase platform (AES-256)** |
| Service-to-service auth: JWT (Supabase), bearer tokens (vendors), GCP identity token (Cloud Run) | **A** |
| Secrets held in Supabase Edge Function environment | **A** |
| **No secret keys in frontend code** | **A — verified.** Only the Supabase URL and the publishable anon key are shipped, which is their intended use; they grant nothing without a valid JWT and are constrained by RLS. |
| Streaming credential | Short-lived, minted server-side per session | **A** |
| Key rotation policy | **C** |

---

## 8. Vendor detail

### 8.1 OpenAI
- **Endpoints:** `/v1/audio/transcriptions`, `/v1/chat/completions`
- **Models:** `gpt-4o-transcribe` (transcription), `gpt-4o` and `gpt-4o-mini` (letters)
- **Data sent:** dictation audio; consultation transcripts; patient name and NHS
  number where entered; template prompts
- **Retention:** default up to 30 days for abuse monitoring. **API data is not
  used for model training by default.**
- **Required:** Zero Data Retention + EU-resident project **(D)**
- **Readiness:** `OPENAI_API_BASE` already externalised — no code change needed **(A)**

### 8.2 Deepgram
- **Product:** real-time streaming API (`/v1/listen`), model `nova-2-medical`, `en-GB`
- **Endpoint:** `wss://api.eu.deepgram.com` — verified `eu-central-1` **(A)**
- **Data sent:** consultation audio only. No patient identifiers.
- **Retention:** **(D — obtain written confirmation of the account's retention setting)**
- **Note:** the credential is accepted by the global endpoint too, so residency
  is enforced by configuration rather than by the key. An EU-scoped key would
  make US routing impossible even by misconfiguration. **(D — hardening)**

### 8.3 Resend
- **Data sent:** generated letters and/or transcripts, patient identifiers, recipient addresses
- **Region:** **(D — confirm and switch to EU)**

### 8.4 Hugging Face — *no longer in the data path*
Directly answering the question: the Hugging Face `transformers` library and the
`google/medasr` model are used **only** by the legacy MedASR service. That
service:
- is **not called** by the application (OpenAI replaced it as the accurate engine);
- downloads the model **at container build/startup** — a one-way fetch of model
  weights;
- **has never transmitted patient data to Hugging Face.**

It remains *deployed* in `us-east4`. **Recommendation: delete it (C).** That
removes a US processor and the Hugging Face dependency from the estate entirely.

### 8.5 Stripe
Clinician name, email and payment details. **No patient data.** Card details go
directly from the browser to Stripe Checkout — they never touch NoteMD systems.

### 8.6 Google (incidental)
- `oauth2.googleapis.com` — service-account token exchange for Cloud Run. No patient data.
- `dns.google` — region lookup in the diagnostics function. Hostnames only.
- `fonts.googleapis.com` — see §5.3.

---

## 9. Data subject rights

| Requirement | Mechanism | Status |
|---|---|---|
| Locate a user's data | `gdpr_export_user()` returns profile, recordings, letters, templates, audit log as JSON | **A** |
| Export | Same function; Article 15/20 | **A** |
| Delete clinical data | `gdpr_erase_user()` — letters, recordings, templates and storage objects | **A** |
| Delete audio files | Included above — storage objects removed by `{user_id}/` prefix | **A** |
| Propagation | Foreign keys cascade; storage deleted in the same transaction | **A** |
| Delete the auth account | **C — requires Supabase admin API; no in-app flow** |
| Backups | Deleted data persists in backups until they roll off **(B)** |
| Per-*patient* deletion | **C.** Current tooling is per-*user*. Deleting one patient's records requires manual SQL. **This is likely to be raised in a DPIA** and is worth building. |

Both functions write to the audit log, recording that the action occurred
without copying the erased content.

---

## 10. Audit trail

`processing_audit_log` is append-only (no client INSERT/UPDATE/DELETE policy;
writes come from the service role). Readable only by the subject.

| Event | Status |
|---|---|
| Data export | **A** |
| Data erasure | **A** |
| Audio purged by retention | **A** |
| Login / logout | **C — available in Supabase Auth logs, not the application trail** |
| Record create/access/modify/delete | **C** |
| Transcript creation / letter generation | **C** |
| Export / download by clinician | **C** |
| Administrative access | **C** |

**Assessment: the table and its guarantees exist; event coverage is thin.**
Extending it to the events above is straightforward and is a likely DSPT
requirement.

---

## 11. Browser and local storage

| Item | Status |
|---|---|
| Recovery snapshot namespaced per user | **A** |
| All PHI purged on sign-out (including other users' residue) | **A** |
| Legacy un-namespaced key cleaned up | **A** |
| Session tokens cleared on sign-out | **A — Supabase client** |
| IndexedDB | **A — not used** |
| Cookies | **A — none set by the application** |
| Temporary audio | **A — held in memory only; released on discard/navigation** |
| Downloaded files | **B — letters copied to clipboard or emailed; no file download implemented** |
| Browser cache | **B — static assets only; no API responses cached** |

Covered by automated tests, including one proving a second clinician on a shared
workstation cannot read the first clinician's cached data.

---

## 12. Security testing

| | Status |
|---|---|
| Automated test suite | **A — 102 tests** |
| Engine routing / transcript integrity | **A** |
| Browser PHI isolation | **A** |
| Schema/constraint conformance | **A** |
| Edge function CORS hygiene | **A** |
| **Cross-user access (IDOR) against a live database** | **C** |
| **Dependency vulnerability scanning in CI** | **C** |
| **Independent penetration test** | **D — must be commissioned** |

---

## 13. Backup and recovery **(B — all items to confirm against the Supabase plan)**

Backups are managed by Supabase: daily backups on all plans, with
point-in-time recovery on Pro and above. They inherit the project region
(`eu-west-1`) and platform encryption at rest. Access is limited to project
administrators.

**To confirm:** current plan, backup retention window, whether PITR is enabled,
restoration procedure, and how long erased patient data persists in backups —
the last of these is explicitly asked for in a DPIA.

---

## 14. Production / test separation

| | Status |
|---|---|
| Single Supabase project (production) | **B** |
| No staging project | **C** |
| Local development uses the production Supabase project | **C — risk** |
| Real patient data copied to development | **A — no export/seed tooling exists** |

**Finding:** there is no separate staging environment, so development points at
production. No patient data has been copied out, but a development error could
affect production data. **Recommend a separate staging project (C).**

---

## 15. Summary of outstanding actions

### D — for NoteMD/providers (blocking)
1. **OpenAI Zero Data Retention + EU-resident project.** The only route by which
   patient data currently leaves the EEA. Has external lead time.
2. **Resend** — confirm and switch to the EU region.
3. **Deepgram** — obtain written confirmation of retention; request an EU-scoped key.
4. **Delete `transcribe-chunk`** in the Supabase dashboard.
5. **Commission an independent penetration test.**
6. Retrieve and file dated DPA copies for all sub-processors.

### C — development work, prioritised
1. Per-patient data location and deletion (likely DPIA requirement)
2. Extend the audit trail to logins, record access and letter generation
3. Delete or relocate the MedASR service (removes a US processor and Hugging Face)
4. Cross-user/IDOR tests against a live database
5. Self-host fonts (removes Google as a recipient of clinician IPs)
6. Password reset flow
7. MFA
8. Separate staging environment
9. Redact third-party error bodies before logging
10. In-app account deletion
11. Dependency scanning in CI

### B — verification needed
Render region; Resend region; Supabase backup plan and window; log retention;
confirm the audio purge matches the `segments/` prefix.

---

## Appendix — headline risks

1. **OpenAI transfer.** Patient data leaves the EEA and may be retained for 30
   days. *Until ZDR and the EU project are enabled, use synthetic or anonymised
   data for pilots.*
2. **No per-patient deletion.** Erasure is per-clinician-account.
3. **No MFA.** For a system holding special category data this will be queried.
4. **Thin audit trail.** Structure is sound; event coverage is not.
5. **No staging separation.** Development operates against production.
