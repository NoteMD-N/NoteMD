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
