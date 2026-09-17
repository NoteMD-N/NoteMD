/**
 * Redaction for third-party error responses before they reach the logs.
 *
 * Vendor error bodies are logged to help diagnose failures, but a vendor that
 * echoes the submitted content in an error would place clinical text into
 * retained logs. The likelihood is low and the consequence is a confidentiality
 * breach, so the bodies are reduced to their diagnostic parts before logging.
 *
 * The approach is allow-list rather than pattern-matching: known-safe fields
 * are extracted from a JSON error and everything else is dropped. Attempting
 * to detect and strip clinical content would be unreliable in the other
 * direction — anything not recognised as safe is simply not logged.
 */

/** Fields that carry diagnostic value and cannot contain submitted content. */
const SAFE_FIELDS = [
  "code", "type", "status", "statusCode", "error_code",
  "param", "reason", "detail_type", "err_code",
];

/** Caps any free-text message so an echoed payload cannot be logged wholesale. */
const MAX_MESSAGE_CHARS = 160;

export function redactVendorError(body: string | null | undefined): string {
  const raw = (body ?? "").trim();
  if (!raw) return "(empty response)";

  try {
    const parsed = JSON.parse(raw);
    const source = parsed?.error && typeof parsed.error === "object" ? parsed.error : parsed;

    const parts: string[] = [];
    for (const f of SAFE_FIELDS) {
      const v = source?.[f];
      if (typeof v === "string" || typeof v === "number") parts.push(`${f}=${v}`);
    }

    // A vendor's message is usually a short description, but it is the field
    // most likely to quote the input, so it is truncated rather than trusted.
    const message = source?.message;
    if (typeof message === "string" && message) {
      const trimmed = message.length > MAX_MESSAGE_CHARS
        ? `${message.slice(0, MAX_MESSAGE_CHARS)}…[truncated]`
        : message;
      parts.push(`message="${trimmed}"`);
    }

    return parts.length ? parts.join(" ") : "(no recognised diagnostic fields)";
  } catch {
    // Not JSON — could be an HTML error page or a raw echo of the request.
    // Only the size is safe to record.
    return `(non-JSON response, ${raw.length} chars)`;
  }
}


/**
 * Redaction for a caught exception before it reaches the logs.
 *
 * `console.error("...", error)` looks harmless and is not. A PostgrestError
 * from a failed insert carries a `details` field, and on a constraint
 * violation Postgres fills that with the offending row:
 *
 *   details: "Failing row contains (uuid, user-uuid, 'Jane Smith',
 *             'NHS4857773456', 'Patient presents with chest pain...', ...)."
 *
 * So a rejected letter insert would write the patient's name, NHS number and
 * transcript into retained server logs. `details` and `hint` are therefore
 * dropped outright rather than truncated, and the message is capped because a
 * thrown Error can carry anything the thrower put in it.
 */
export function redactError(err: unknown): string {
  if (err === null || err === undefined) return "(no error object)";

  if (typeof err === "object") {
    const e = err as Record<string, unknown>;
    const parts: string[] = [];

    // Postgres / PostgREST identifiers are fixed vocabularies, never content.
    for (const field of ["name", "code", "status", "statusCode"]) {
      const v = e[field];
      if (typeof v === "string" || typeof v === "number") parts.push(`${field}=${v}`);
    }

    const message = e.message;
    if (typeof message === "string" && message) {
      const trimmed = message.length > MAX_MESSAGE_CHARS
        ? `${message.slice(0, MAX_MESSAGE_CHARS)}…[truncated]`
        : message;
      parts.push(`message="${trimmed}"`);
    }

    // Deliberately not logged: details, hint, body, response, config, request.
    // `details` is where Postgres puts the failing row.
    if (typeof e.details === "string" && e.details) {
      parts.push(`details=[redacted ${e.details.length} chars]`);
    }

    return parts.length ? parts.join(" ") : `(${Object.prototype.toString.call(err)})`;
  }

  if (typeof err === "string") {
    return err.length > MAX_MESSAGE_CHARS
      ? `"${err.slice(0, MAX_MESSAGE_CHARS)}…[truncated]"`
      : `"${err}"`;
  }

  return `(${typeof err})`;
}
