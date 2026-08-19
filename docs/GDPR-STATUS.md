# NoteMD — UK GDPR status and gap analysis

**Last updated:** 19 August 2026
**Status: NOT YET COMPLIANT — see "Blocking gaps" below.**

This document is deliberately blunt. NoteMD processes **special category data**
(health data, UK GDPR Art. 9) about identifiable patients. Getting this wrong is
not a bug, it is a regulatory and patient-safety incident. Nothing here should
be read as legal advice — a DPO or privacy solicitor must sign this off.

---

## 1. What changed in this release, and why it matters

At the client's request, dictation transcription moved from **MedASR**
(self-hosted, private Google Cloud Run instance under NoteMD's control) to
**OpenAI**.

This is a material change to the processing posture. Previously the audio never
left infrastructure the client controlled. Now **patient audio is transmitted to
a third-party processor based in the United States.**

It is *not* a brand-new exposure — patient transcripts were already sent to
OpenAI for letter generation, and Deepgram (also US-based) already received
consultation audio. But it widens the surface and makes the items in §3
unavoidable rather than merely advisable.

A single environment variable, `TRANSCRIBE_ACCURATE_PROVIDER=medasr`, reverts
transcription to the self-hosted engine with no code change, should the DPO
require that pending sign-off.

---

## 2. Implemented in this release (technical controls)

| Control | UK GDPR | Where |
|---|---|---|
| Automatic audio purge after a retention period (default 30 days, per-clinician) | Art. 5(1)(e) storage limitation | `gdpr_purge_expired_audio()` |
| Right of access / data portability — full JSON export | Art. 15, Art. 20 | `gdpr_export_user()` |
| Right to erasure — deletes letters, recordings, templates and stored audio | Art. 17 | `gdpr_erase_user()` |
| Append-only processing audit log | Art. 30, accountability | `processing_audit_log` |
| Row-level security isolating each clinician's data | Art. 32 | existing RLS policies |
| Encryption in transit (TLS) and at rest | Art. 32 | Supabase platform |
| Transcript provenance shown in the UI | transparency | provider badge on Record page |

These are **necessary but not sufficient**. They do not by themselves make the
product compliant.

---

## 3. Blocking gaps — must be closed before processing real patient data

These are ordered by how likely each is to stop the project.

### 3.1 Data Processing Agreements with every sub-processor
NoteMD is the **processor**; the NHS body or private clinic is the
**controller**. A written Art. 28 contract is required with each sub-processor:

- **OpenAI** — transcription + letter generation. OpenAI provides a DPA and
  offers Standard Contractual Clauses with the UK International Data Transfer
  Addendum. Must be executed.
- **Deepgram** — fast-engine transcription. Same requirement.
- **Supabase** — database, storage, auth. Same requirement.
- **Resend** — letter/transcript email delivery. Same requirement.
- **Render** — application hosting. Same requirement.

**Action:** execute all five. None are in place as far as I can establish.

### 3.2 Zero Data Retention with OpenAI
By default OpenAI retains API inputs for up to 30 days for abuse monitoring.
For special category health data this is very hard to justify. OpenAI offers
**Zero Data Retention (ZDR)** for eligible endpoints on request.

**Action:** apply for ZDR covering both the audio transcription and chat
completion endpoints. Until granted, patient-identifiable audio should arguably
not be sent. This is the single most important item on this list.

### 3.3 International transfer mechanism
US transfers need a valid Art. 44–49 mechanism — SCCs plus the UK Addendum, and
a documented Transfer Risk Assessment.

**Action:** complete a TRA per sub-processor.

### 3.4 Data Protection Impact Assessment (DPIA)
Mandatory under Art. 35: large-scale processing of special category data using
new technology. An NHS body will ask for this before procurement.

**Action:** complete a DPIA. Consider the ICO template.

### 3.5 Lawful basis and patient transparency
Needs documenting: Art. 6 basis (likely 6(1)(e) public task for NHS, or 6(1)(b)
private) **and** an Art. 9 condition (likely 9(2)(h) health/social care).
Patients must be told AI is used in producing their records.

**Action:** document the basis; supply controllers with privacy-notice wording.

### 3.6 Breach notification procedure
72-hour controller notification under Art. 33.

**Action:** write and test the runbook.

### 3.7 Records of Processing Activities
Art. 30 register covering categories of data, recipients, transfers, retention.

**Action:** create the ROPA. The new audit log supports it but is not a substitute.

---

## 4. Recommended, not blocking

- **DSPT** — NHS Data Security and Protection Toolkit; required by most trusts.
- **Cyber Essentials Plus** — commonly required in NHS procurement.
- **Penetration test** — independent, before go-live.
- **Sub-processor change notice** — contractual duty to inform controllers.
- **Patient-data segregation** — consider EU/UK-region Supabase hosting.
- **Retention for transcripts/letters** — currently 10 years by default, which
  matches NHS record retention, but should be confirmed per controller.

---

## 5. Honest summary

The engineering controls a developer can build are now largely in place:
retention, erasure, export, audit logging, access control, and provenance.

**The remaining gaps are contractual and organisational, and cannot be closed
in code.** Items 3.1 (DPAs) and 3.2 (OpenAI Zero Data Retention) in particular
require someone at NoteMD to sign agreements. Until at least those two are
done, my recommendation is:

> Do not process real, identifiable patient data in production.

Use synthetic or fully anonymised data for demos and pilots until the DPAs and
ZDR are executed. If that is not acceptable to the timeline, set
`TRANSCRIBE_ACCURATE_PROVIDER=medasr` to keep audio on self-hosted
infrastructure — though this does not address the letter-generation path, which
already sends transcripts to OpenAI.
