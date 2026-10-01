# Safe-log regression — rejected clinical rows

Demonstrated 1 October 2026 against the live staging database. The error below
is genuine: a real constraint violation produced by the database, not a test
fixture.

## The error the database returns

An insert was rejected. PostgREST surfaced this:

    code:    23502
    message: null value in column "recording_id" of relation "letters"
             violates not-null constraint
    details: Failing row contains (11f96129-…, null, 00000000-…, null,
             Dear Colleague, Re: Alex Testcase (NHS 485 777 3456).
             Three-week history of exertional chest pain…, not_a_valid_status, …)

The `details` field contains the rejected row in full: patient name, NHS
number and clinical narrative. (Synthetic data — "Alex Testcase" is fictional.)

## What the previous code would have written

    console.error("send-letter-email error:", error);

    → {"code":"23502","details":"Failing row contains (11f96129-…,
       Dear Colleague, Re: Alex Testcase (NHS 485 777 3456). Three-week…

## What the deployed code writes

    console.error("send-letter-email error:", redactError(error));

    → code=23502 message="null value in column "recording_id" of relation
      "letters" violates not-null constraint" details=[redacted 296 chars]

## Verification

| Checked for | Present in current log output |
| --- | --- |
| Patient name (`Alex Testcase`) | no |
| NHS number (`485 777 3456`) | no |
| Clinical narrative (`chest pain`) | no |
| Row dump marker (`Failing row`) | no |

The diagnostic value is preserved — the error code and the constraint that was
violated are both retained, which is what an engineer needs. The size of the
dropped field is recorded so the omission is visible rather than silent.

Enforced across all 11 edge functions and 3 shared modules by
`src/test/log-hygiene.test.ts`, which fails the build if any call site logs a
bare error object, a clinical variable, or authentication material. That suite
was verified non-vacuous by introducing both violation types and confirming
each was reported before reverting.

## Historical logs

Edge function logs are retained by Supabase on a rolling window determined by
the project's plan; they are not exported or copied anywhere by NoteMD, and no
application code writes them to any other store. Entries written before the
redaction fix was deployed (21 September 2026) therefore age out of that
window on the platform's normal schedule without further action.

All such entries originated from synthetic and development traffic during the
period the defect existed; the audit trail shows no production letter-send
failures of this class in that window.
