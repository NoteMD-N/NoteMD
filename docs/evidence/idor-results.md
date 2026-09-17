# Cross-user / IDOR test results

Run: 2026-09-17T10:54:15.187Z
Target: toeurvqqucloareeujfa (staging, synthetic data)

Every row is an access attempt that must be refused.

| Scenario | Actor | Target | Blocked | Observed |
| --- | --- | --- | --- | --- |
| List all letters | Clinician A | B's letter | yes | 1 row(s), none belonging to B |
| Fetch letter by manipulated id | Clinician A | letter 6fdc5f50… | yes | 0 row(s) returned |
| Fetch recording by manipulated id | Clinician A | recording 0a34869b… | yes | 0 row(s) returned |
| Update another clinician's letter | Clinician A | B's letter | yes | 0 row(s) affected; content unchanged |
| Delete another clinician's recording | Clinician A | B's recording | yes | row still present |
| Download another clinician's audio | Clinician A | B's audio object | yes | error: Object not found |
| List another clinician's storage folder | Clinician A | B's folder | yes | 0 object(s) listed |
| Read another clinician's profile | Clinician A | B's profile | yes | 0 row(s) returned |
| Secretary modifies assigned clinician's letter | Secretary of A | A's letter | yes | content unchanged (read-only) |
| Secretary reads unassigned clinician's letter | Secretary of A | B's letter | yes | 0 row(s) returned |
| Secretary downloads unassigned clinician's audio | Secretary of A | B's audio object | yes | error: Object not found |
| Self-assign as secretary of another clinician | Outsider | A's records | yes | clinician_id rejected |
| Self-promote to admin | Outsider | own profile role | yes | role is now "clinician" |
| Forge an audit entry against another user | Outsider | A's audit trail | yes | recorded against self, outcome "denied" |
| Modify an audit record | Outsider | audit log | yes | error: permission denied for table processing_audit_log |
| Consume a rate-limit allowance unauthenticated | Anonymous | rate_limit_counters | yes | error: not authenticated |
| Read and reset own rate-limit counters | Outsider | rate_limit_counters | yes | 0 row(s) readable; 1 row(s) survived the delete |
| Refresh a session after revocation | Revoked user | own session | yes | error: Invalid Refresh Token: Refresh Token Not Found |

Attempts: 18 · Blocked: 18 · Not blocked: 0
