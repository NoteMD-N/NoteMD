# Supabase backup and recovery configuration

Gathered 17 September 2026 from the Supabase CLI against both projects.

## Projects and regions

| Project | Reference | Region |
| --- | --- | --- |
| NoteMD (production) | `mdunhinhsrdrilxcdbvq` | West EU (Ireland) — `eu-west-1` |
| NoteMD Staging | `toeurvqqucloareeujfa` | West EU (Ireland) — `eu-west-1` |

Staging is in the same region as production, so the residency position covers
both environments.

## Backups

    $ supabase backups list --project-ref mdunhinhsrdrilxcdbvq

     REGION            | BACKUP TYPE | STATUS    | CREATED AT (UTC)
    -------------------|-------------|-----------|---------------------
     West EU (Ireland) | PHYSICAL    | COMPLETED | 2026-09-17 04:15:39
     West EU (Ireland) | PHYSICAL    | COMPLETED | 2026-09-16 04:17:50
     ... (8 total)
     West EU (Ireland) | PHYSICAL    | COMPLETED | 2026-09-10 04:14:12

| Property | Value | Source |
| --- | --- | --- |
| Frequency | Daily, approximately 04:15 UTC | CLI listing |
| Retention | 7 days (8 backups, 10–17 September) | CLI listing |
| Type | Physical | CLI listing |
| Storage region | West EU (Ireland) | CLI listing |
| Status | All `COMPLETED`, no failures in the window | CLI listing |

Backups are held in the same region as the database, so they do not create a
transfer outside the EEA.

### To confirm in the dashboard

Two properties cannot be read from the CLI and should be recorded for the
evidence pack:

- **Point-in-time recovery.** `supabase backups restore` exists as a command,
  but PITR is a paid add-on and its presence in the CLI does not mean it is
  enabled. Check Database → Backups. Without PITR, the recovery point
  objective is up to 24 hours; with it, typically two minutes.
- **Who can access backups.** Backup download and restore follow Supabase
  organisation roles. This belongs with the production access register
  (item 13).

Encryption at rest is provided by Supabase for both the database and its
backups; this is a vendor-level control and is evidenced from their
documentation rather than from the project.

## Deleted data and the backup window

A record erased through `gdpr_erase_patient` is removed from the live database
immediately, but remains inside physical backups until those backups age out —
**up to 7 days**.

This is worth stating plainly in the DPIA rather than leaving implicit. It is
the ordinary position for any backed-up system and is generally accepted as
compatible with Article 17, on the basis that the data is beyond routine
access, is not processed further, and is destroyed on a defined schedule. The
alternative — selectively editing backups — would compromise their integrity
and is not something any mainstream platform supports.

## Recovery test

A restore has been rehearsed rather than assumed. See `recovery-test.md`,
produced by `scripts/recovery-test.sh`.

## Retention purge

The scheduled audio purge is present and active:

    $ psql ... -c "select jobname, schedule, active from cron.job"
    notemd-audio-retention-purge | 30 2 * * * | t

It runs daily at 02:30 UTC, deletes audio objects whose retention period has
elapsed, blanks the stored path, and records an `audio_purged_retention` entry
in the audit log for each one.
