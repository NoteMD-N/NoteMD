# NoteMD — UK GDPR status and gap analysis

**Last updated:** 19 August 2026
**Status: technical controls in place; documentation and OpenAI Zero Data
Retention outstanding — see §3 and §5.**

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

## 2a. Data residency

UK GDPR treats the EEA as adequate, so EU storage satisfies a UK residency
requirement — it does not have to be London specifically. Confirm with the
individual trust if any of them mandate UK-only rather than UK/EEA.

| Component | What it holds | Region | Status |
|---|---|---|---|
| Supabase (Postgres + storage) | **All patient data at rest** — transcripts, letters, patient identifiers, audio | `eu-west-1` (Ireland) | **EU — compliant** |
| Supabase edge functions | Transient processing only, no persistence | Co-located with project | EU |
| OpenAI | Audio + transcripts in transit; retained up to 30 days unless ZDR granted | Global by default | **Action: move to an EU-resident project** |
| Deepgram | Consultation/fast-engine audio in transit | Global by default | Action, or remove entirely (see below) |
| Resend | Letters and transcripts sent by email | Check account region | Action: switch to EU region |
| Render | Static frontend bundle only — **no patient data at rest** | Check service region | Low priority; no PHI at rest there |
| MedASR (Cloud Run) | Fallback engine only, currently unused | **`us-east4` (Virginia)**, image in `us-central1` (Iowa) | **Action: redeploy to EU, or delete** — see `medasr-service/deploy-eu.sh` |

**The important line in that table is the first one:** the database and audio
storage — everything that actually persists — are already in the EU. The
remaining items are processors that receive data *in transit*.

### Reducing the residency surface
Deepgram now serves only the "Fast" dictation engine and live consultation
transcription. Since OpenAI is the accurate engine and has been validated by the
client, removing Deepgram would eliminate one processor from the DPIA, one DPA
to evidence, and one region to arrange. The trade-off is losing the word-by-word
live transcript during consultations, as OpenAI works in ~10 second segments.
This is a product decision, not a technical constraint.

### Implementation note
`OPENAI_API_BASE` makes the OpenAI endpoint configurable, so moving to an
EU-resident OpenAI project is an environment variable change rather than a code
change. Set it alongside the Zero Data Retention application (§3.2) — both are
arranged through the same OpenAI account conversation.

---

## 3. Outstanding items before processing real patient data

Only §3.2 is a hard external blocker. The rest is documentation and evidence
gathering that NoteMD controls and can run in parallel.

These are ordered by how likely each is to stop the project.

### 3.1 Data Processing Agreements — mostly already in place
**Status: likely satisfied, needs evidencing rather than negotiating.**

Modern SaaS providers incorporate their DPA into the standard terms accepted at
signup, rather than requiring a separately negotiated contract. That is the case
for the providers in this stack, so NoteMD is in most cases *already* on a DPA
by virtue of holding an account.

What is still required is not signature but **evidence and record-keeping**: an
NHS trust or controller will ask *which* DPA version applies, and "it is in their
terms" is only an acceptable answer if you can produce it.

| Sub-processor | Purpose | Action |
|---|---|---|
| OpenAI | transcription + letter generation | Confirm the API DPA applies to this account; download a copy. Note some providers require a short form to execute — verify. |
| Deepgram | fast-engine transcription | Download the DPA referenced in the current terms. |
| Supabase | database, storage, auth | Confirm DPA coverage on the current plan (free tiers sometimes differ). |
| Resend | email delivery | Download the DPA. |
| Render | application hosting | Download the DPA. |

**Action:** retrieve and file a dated copy of each, and record the version in the
ROPA (§3.7). Confirm the paid-plan terms apply — some providers' free tiers carry
different or reduced data-protection commitments.

Note also that a DPA existing does not automatically make a processor
*appropriate* for special category health data at scale. That judgement is the
DPIA's job (§3.4).

### 3.2 Zero Data Retention with OpenAI
**Status: NOT automatic. This remains the main technical blocker.**

This one is genuinely not covered by the DPA. By default OpenAI retains API
inputs for up to 30 days for abuse monitoring. The DPA governs *how* they may
process that data — it does not remove the retention window.

API data is not used to train OpenAI's models by default, which is a separate
and helpful point, but it is not the same as non-retention.

For special category health data a 30-day third-party retention window is hard
to justify to a trust. OpenAI offers **Zero Data Retention** for eligible
endpoints on request.

**Action:** apply for ZDR covering both the audio transcription and chat
completion endpoints. Until granted, this is the strongest argument against
putting identifiable patient data through production.

### 3.3 International transfer mechanism
**Status: mechanism likely covered; the assessment is not.**

US transfers need a valid Art. 44–49 mechanism. The SCCs and UK International
Data Transfer Addendum are normally bundled into the same auto-incorporated DPA
covered in §3.1, so the *mechanism* is probably already in place.

The **Transfer Risk Assessment** is NoteMD's own obligation and is not provided
by the vendor.

**Action:** complete a TRA per sub-processor. This is a document you write, not
one you obtain.

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

The engineering controls a developer can build are in place: retention, erasure,
export, audit logging, access control, and provenance.

On the contractual side, the position is better than a first pass suggested:
DPAs with these providers are generally incorporated into the terms already
accepted at signup, so §3.1 is largely a matter of retrieving and filing
evidence rather than negotiating agreements. International transfer mechanisms
are usually bundled into those same DPAs.

**What genuinely remains outstanding:**

1. **OpenAI Zero Data Retention** (§3.2) — not covered by any DPA, must be
   applied for. This is the main technical blocker.
2. **NoteMD's own documentation** — DPIA, lawful basis, ROPA, Transfer Risk
   Assessments, privacy-notice wording, breach runbook. No vendor supplies
   these; they are the controller/processor's own records.
3. **Evidence pack** — dated copies of each DPA, for procurement.

Recommendation: item 1 is the one to start today, as it has an external lead
time. Items 2 and 3 are internal work that can proceed in parallel.

Until ZDR is granted, the safer default for pilots is synthetic or anonymised
data. `TRANSCRIBE_ACCURATE_PROVIDER=medasr` keeps audio on self-hosted
infrastructure, though letter generation still sends transcripts to OpenAI.
