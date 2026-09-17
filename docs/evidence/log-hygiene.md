# Clinical content in logs — review and findings

Reviewed 17 September 2026 across all 11 edge functions, the three shared
modules, and client-side logging. Enforced going forward by
`src/test/log-hygiene.test.ts`.

## Finding: raw error objects were being logged (fixed)

Every edge function ended with a catch-all of the form:

    console.error("generate-letter error:", error);

That reads as harmless and is not. `supabase-js` surfaces a Postgres failure
as a `PostgrestError` carrying a `details` field, and on a constraint
violation Postgres fills that field with the row that was rejected:

    details: "Failing row contains (b1f2, 9c3a, 'Jane Smith', 'NHS4857773456',
              'Patient presents with a three-week history of chest pain
               radiating to the left arm...', draft)."

A rejected letter insert would therefore have written the patient's name, NHS
number and transcript into retained server logs — from a line whose author was
logging "the error".

This was not hypothetical for this codebase: a `recordings.status` CHECK
constraint mismatch caused exactly this class of rejection earlier in the
project, repeatedly, in production.

**Fixed.** `redactError()` in `supabase/functions/_shared/redact.ts` reduces a
caught value to an allow-list of `name`, `code`, `status`, and a message capped
at 160 characters. `details` and `hint` are dropped outright rather than
truncated — `details` is where the row goes — and their size is recorded so the
omission is visible. `body`, `response`, `config` and `request` are never read.

All 42 logging call sites across the 11 functions and 3 shared modules now
route caught values through it.

## What is logged

| Category | Logged | Example |
| --- | --- | --- |
| Provider tier and counts | yes | `provider=streaming chars=1842` |
| Storage paths | yes | `<user-uuid>/1789465862.webm` — pseudonymous, no patient data |
| Account identifiers | yes | `user_id`, `customer_id` — pseudonymous |
| Error codes and capped messages | yes | `code=23514 message="…violates check constraint"` |
| Transcripts, letter bodies, prompts | **no** | — |
| Patient names, NHS numbers, DOB | **no** | — |
| Audio content | **no** | — |
| Authorization headers, API keys, JWTs | **no** | — |
| Vendor error bodies | redacted | allow-listed fields only; non-JSON reduced to a size |

## Enforcement

`src/test/log-hygiene.test.ts` (9 tests) covers both halves:

1. That `redactError()` and `redactVendorError()` actually drop the dangerous
   fields, tested against the exact `PostgrestError` shape a CHECK violation
   produces.
2. That every call site uses them — no bare `error` variable, no clinical
   identifier, no authentication material passed to `console.*`.

The call-site checks examine evaluated expressions rather than raw source, so
a string literal such as `"[send-transcript-email]"` is not mistaken for
logging a transcript.

The suite was verified non-vacuous by introducing both violation types and
confirming each was reported before reverting.

## Client-side logging

Browser console statements log error messages and connection state only
(`readyState`, close codes, reconnect attempts). No transcript, letter or
patient identifier is written to the browser console. These do not leave the
device and are not collected; there is no client-side error reporting service
configured, so no clinical content leaves the browser by that route.
