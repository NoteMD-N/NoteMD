# Quotation — NHS Assurance Workstream

**Prepared:** 28 August 2026
**For:** NoteMD
**Ref:** VAL-25008 — additional milestone, separate from the original MVP scope

Covers the three items identified as falling outside the original development
scope. Provided under clause 6.2 of the Freelancer Services Agreement, which
requires additional work to proceed via an agreed written quote.

> **Rate:** £____ per day *(insert agreed day rate)*
> All figures are working days of effort. VAT excluded.

---

## Summary

| # | Item | Effort | Cost |
|---|---|---|---|
| 1 | Expanded clinical audit trail | 4–5 days | £____ |
| 2 | Separate staging environment | 2–3 days | £____ |
| 3 | Automated cross-user / IDOR security tests | 2–3 days | £____ |
| | **Total** | **8–11 days** | **£____** |

Items may be commissioned individually, with one dependency noted in §4.

---

## 1. Expanded clinical audit trail — 4–5 days

**Objective.** Record who did what, and when, across the clinical record
lifecycle, without copying clinical content into the audit log.

**Events covered**

| Category | Events |
|---|---|
| Authentication | Sign-in, sign-out, failed sign-in, password change, second-factor enrolment and removal |
| Clinical records | Recording created, viewed, modified, deleted |
| Documentation | Transcript created, letter generated, letter regenerated, letter edited |
| Disclosure | Letter or transcript exported, copied, emailed |
| Administration | Secretary granted or revoked, retention settings changed, data subject requests |

**Included**
- Schema extension with indexed event types and actor/subject/resource fields
- Server-side capture in the edge functions, so events cannot be suppressed by a modified client
- Authentication events captured via a Supabase auth hook rather than the client, which would otherwise be trivially bypassable
- An audit viewer in the application, filterable by date, actor and event type — an audit trail that can only be read by querying the database directly is of limited value in an assurance review
- Export of a filtered audit range as CSV, for incident investigation
- Retention policy for audit records
- Automated tests confirming events are written, contain no clinical content, and cannot be altered or deleted through the application

**Excluded**
- Forwarding to an external SIEM or log aggregation platform
- Real-time alerting on suspicious activity
- Tamper-evidence beyond append-only (cryptographic chaining is available as a variation if the DPIA requires it)

**Note.** The append-only table and its guarantees already exist; this
work extends event coverage and adds the interface. It is not a rebuild.

---

## 2. Separate staging environment — 2–3 days

**Objective.** A fully separated environment so development and testing never
touch production data.

**Included**
- A second Supabase project in the same EU region, with its own database, storage, authentication and secrets
- All migrations applied, so the schema matches production
- A synthetic data generator producing realistic but entirely fictional patients, transcripts and letters — no production data is ever copied
- A separate hosting deployment tracking a staging branch
- Environment configuration separating the two, so it is not possible to point local development at production by accident
- Documentation of the promotion path from staging to production

**Excluded**
- Ongoing hosting costs for the second environment, which are billed by the providers directly (a Supabase Pro project is currently $25/month; the hosting tier may also increase)
- A third pre-production or UAT environment

**Note.** This also addresses a finding in the technical review: development
currently operates against production infrastructure.

---

## 3. Automated cross-user / IDOR security tests — 2–3 days

**Objective.** Demonstrate, repeatably and on every change, that one clinician
cannot reach another's data.

**Included**
- A test harness provisioning multiple real user accounts against a live database
- Systematic cross-access attempts covering:
  - Direct record access by identifier across all clinical tables
  - Filter and query manipulation attempting to widen result sets
  - Storage object access using another user's path
  - Direct invocation of database functions with another user's identifiers
  - Edge function calls carrying another user's record identifiers
  - Secretary delegation boundaries — reaching a clinician they are not assigned to
  - Data subject request functions, confirming they cannot act on another clinician's patients
- Assertions that row level security refuses each attempt at the database layer
- Integration into the automated test suite so a policy regression fails the build
- A written summary of coverage and results, suitable for the penetration tester and for DTAC evidence

**Excluded**
- Penetration testing itself, which must be independent to carry assurance value
- Remediation of findings from the independent test

**Dependency.** These tests create and destroy user accounts and records, so
they require the staging environment (item 2). Running them against production
is not appropriate.

---

## 4. Sequencing

Item 2 should precede item 3. Item 1 is independent and can run in parallel or
separately.

A sensible order is **2 → 3 → 1**, which places the environment separation and
the access-control evidence — the two most likely to be examined in a DTAC
review — first.

---

## 5. Assumptions

- Provider accounts (Supabase, hosting) can be created under NoteMD's own billing, per clause 6.3
- Existing schema and access-control model are the baseline; no redesign is included
- Work proceeds against the current production architecture; a change of provider during the milestone would require re-quoting
- Review and acceptance within 5 working days of delivery

## 6. Not included in this quotation

Listed for clarity, and consistent with the technical review:

| Item | Owner |
|---|---|
| Independent penetration test | NoteMD to commission directly |
| Remediation of penetration test findings | Quoted separately once the report exists; effort cannot be estimated in advance |
| The DPIA, DSPT submission and DCB0129 clinical safety documentation | NoteMD and its DPO / Clinical Safety Officer |
| Provider contracts, Zero Data Retention and EU project enablement | NoteMD |

**Technical support for the penetration tester** — supplying architecture
information, environment access and answering technical queries — is included
at no charge, up to one day. Beyond that it would be quoted.

## 7. Also included at no charge

Delivered within the existing engagement, as agreed:

- Two-factor authentication and password recovery
- Per-patient location, export and erasure
- Streaming privacy opt-out applied to every request, with automated verification
- Vendor error redaction in logs
- Removal of the retired function
- Verification of the Resend EU configuration once activated
- A final update of the Technical Review Response to reflect the production
  configuration, once the outstanding provider changes are complete

---

**Validity:** 30 days from the date above.
