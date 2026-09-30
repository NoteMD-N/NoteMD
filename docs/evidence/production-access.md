# Production access register

Compiled 30 September 2026 from the Supabase Management API and the project
configuration. Records who can reach production clinical data, by what means.

## Supabase — production project `mdunhinhsrdrilxcdbvq`

Organisation: **NoteMD** (`syqzkpxolrihfjktiinr`)

| Account | Role | MFA | Access |
| --- | --- | --- | --- |
| `abualapass123@yahoo.com` | Owner | **disabled** | Full — database, storage, secrets, backups |
| `chris@valoco.co` | Administrator | **disabled** | Full — database, storage, secrets, backups |

Two accounts hold unrestricted access to the production clinical database.
Supabase organisation roles are not scoped per project, so both also reach the
staging project.

### Finding: no multi-factor authentication on either administrative account

NoteMD requires MFA of its clinicians. The two accounts that can read every
patient record in the database do not have it. A single password compromise on
either account exposes the entire dataset, bypassing every control described
elsewhere in this pack — Row Level Security included, since organisation
owners can read the database directly.

This will be raised by any competent penetration test and is a DSPT
expectation.

**Action:** enable MFA on both accounts. Supabase Dashboard → Account
Preferences → Security. This costs nothing and takes minutes.

### Finding: the Owner account is a personal webmail address

The account holding Owner rights over production is a `yahoo.com` address
rather than one on a domain the company controls. Two consequences:

- Account recovery depends on a third-party consumer mailbox outside the
  organisation's control.
- If the individual becomes unavailable, there is no administrative route to
  recover ownership of the production environment.

**Action:** move Owner to an address on `notemd.co.uk`, which is already
managed in Microsoft 365, and keep the personal address as a member at most.

## Other systems

| System | Who has access | Notes |
| --- | --- | --- |
| Render (frontend hosting) | Account holder | Static hosting only. No clinical data, no request bodies, no tokens. |
| Azure (AI and email) | Client's Entra tenant, with developer added as guest | Resources in the client's subscription and billed to the client. |
| Deepgram | Client's own account | Migrated from the developer's account. |
| Google Cloud (retired transcription service) | Developer's personal account | Being decommissioned; holds no current clinical data. |

## Recovery position

| Property | Value | Source |
| --- | --- | --- |
| Region | `eu-west-1` | Management API |
| Daily physical backups | 8 retained, most recent completed | Management API |
| Write-ahead log archiving | enabled | Management API |
| **Point-in-time recovery** | **not enabled** | Management API (`pitr_enabled: false`) |

### Finding: recovery point objective is up to 24 hours

Without point-in-time recovery, the most recent restorable state is the last
nightly backup. A failure late in the working day could lose a full day of
consultations, transcripts and letters — clinical work that cannot be
reconstructed, because the audio is not retained beyond its own retention
period and the consultation itself is over.

Point-in-time recovery is a paid Supabase add-on and reduces the objective to
approximately two minutes.

**Action:** a decision for the client. The cost is modest against the
consequence of losing a day of clinical documentation, and an NHS pilot
organisation is likely to ask what the recovery point objective is.

## Revocation

Removing a person's access means removing their organisation membership in
Supabase, their guest account in the client's Entra tenant, and their Render
access, then rotating any credential they could have read — Supabase service
role key, database password, Deepgram key, Azure keys, and the ACS connection
string.
