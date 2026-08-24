/**
 * Shared CORS headers for every edge function.
 *
 * WHY THIS IS SHARED
 * ------------------
 * The Supabase JS client attaches `x-supabase-client-*` headers to browser
 * requests. Any header the browser sends must appear in
 * Access-Control-Allow-Headers or the preflight fails and the request never
 * leaves the browser — surfacing as the opaque supabase-js error
 * "Failed to send a request to the Edge Function", which looks like the
 * function is missing rather than a CORS rejection.
 *
 * That bug was fixed once in generate-letter and left in place everywhere
 * else, so each new function reintroduced it. Defining the list here means it
 * is fixed in one place and stays fixed.
 *
 * If a future client version sends a new header, add it here.
 */
export const ALLOWED_HEADERS = [
  "authorization",
  "x-client-info",
  "apikey",
  "content-type",
  "x-supabase-client-platform",
  "x-supabase-client-platform-version",
  "x-supabase-client-runtime",
  "x-supabase-client-runtime-version",
] as const;

export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": ALLOWED_HEADERS.join(", "),
};
