# Backup and recovery test

Run: 2026-09-17T11:17:04Z
Target: NoteMD Staging (`toeurvqqucloareeujfa`), West EU (Ireland) — synthetic data only.

A backup that has never been restored is a hypothesis. This exercises the
procedure end to end: capture, destroy, restore, and verify that what came
back is what went in.

## Method

A logical dump rather than a physical restore. Supabase's physical backups
replace an entire project, so rehearsing one would destroy the environment
being rehearsed in. What this proves is the part actually in doubt — that the
data can be captured, that a loss can be recovered from that capture, and that
the links between letters and their recordings survive the round trip.

## Result

| Stage | Recordings | Letters | Content checksum |
| --- | --- | --- | --- |
| Seeded | 25 | 25 | `7d47ecaa659eeabb` |
| After simulated loss | 0 | 0 | — |
| After restore | 25 | 25 | `7d47ecaa659eeabb` |

Backup size: 15956 bytes.
Orphaned letters after restore (letter with no recording): 0.

**Verdict: PASS**

The checksum covers patient identifier and letter body for every restored row,
so the test distinguishes "the right number of rows returned" from "the right
rows returned with their content intact".

## Reproducing

    export SUPABASE_DB_PASSWORD_STAGING='...'
    ./scripts/recovery-test.sh

The script refuses to run against the production project.
