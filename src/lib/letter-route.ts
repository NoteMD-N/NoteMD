/**
 * Letter routing without the identifier in the URL path.
 *
 * WHY
 * ---
 * The frontend is served by a static host, which — like any web server — logs
 * the requested path. With a path-based route (/letter/<uuid>) a direct
 * navigation or refresh placed the letter's identifier into a third party's
 * access logs. That identifier is pseudonymous rather than directly
 * identifying, but it is still a reference to a clinical record, and holding
 * it in a third-party log serves no purpose.
 *
 * The identifier now travels in the URL *fragment*. Browsers never transmit
 * the fragment in an HTTP request, so the host receives only "/letter".
 * Everything else behaves as before: the page can be refreshed, bookmarked,
 * and navigated back to, because the fragment stays in the address bar.
 *
 * Referrer headers also omit the fragment, so it cannot leak to any other
 * origin the page links to.
 */

export const LETTER_PATH = "/letter";

/** Route target for a given letter. */
export function letterRoute(letterId: string): string {
  return `${LETTER_PATH}#${encodeURIComponent(letterId)}`;
}

/**
 * Read the letter id from a fragment.
 *
 * Accepts the raw `location.hash` (with or without the leading "#").
 * Returns null when absent or malformed rather than throwing, so the page can
 * show a "letter not found" state instead of failing to render.
 */
export function letterIdFromHash(hash: string | null | undefined): string | null {
  const raw = (hash ?? "").replace(/^#/, "").trim();
  if (!raw) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null; // malformed percent-encoding
  }
  // Only ever a UUID — reject anything else rather than passing it to a query.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return UUID_RE.test(decoded) ? decoded : null;
}
