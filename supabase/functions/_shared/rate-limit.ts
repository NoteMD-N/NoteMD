/**
 * Rate limiting for sensitive edge functions.
 *
 * Counters live in Postgres (see the check_rate_limit migration) because edge
 * functions are stateless and horizontally scaled — an in-memory counter would
 * limit nothing.
 *
 * Limits are set generously. This is abuse protection, not a quota: a busy
 * clinic must never hit them, so the numbers are well above any plausible
 * clinical day and are there to bound a stolen token or a runaway client.
 */

/** Buckets, with their ceiling per window. */
export const RATE_LIMITS = {
  /**
   * Streaming credentials. One per dictation session normally, but a flaky
   * connection re-mints on every reconnect, so the ceiling is high.
   */
  "deepgram-token": { limit: 120, windowSeconds: 3600 },

  /**
   * Segment transcription. A long consultation is transcribed in many pieces,
   * so this is the highest of the set by some distance.
   */
  "transcribe-audio": { limit: 400, windowSeconds: 3600 },

  /** Letter generation — the expensive model call. */
  "generate-letter": { limit: 60, windowSeconds: 3600 },
  "regenerate-letter": { limit: 90, windowSeconds: 3600 },

  /** Anything that puts correspondence in front of a recipient. */
  "send-letter-email": { limit: 60, windowSeconds: 3600 },
  "send-transcript-email": { limit: 60, windowSeconds: 3600 },

  /** Account administration. Legitimately rare. */
  "manage-secretary": { limit: 20, windowSeconds: 3600 },
} as const;

export type RateLimitBucket = keyof typeof RATE_LIMITS;

interface RpcClient {
  rpc(
    fn: string,
    args: Record<string, unknown>,
  ): Promise<{ data: unknown; error: { message: string } | null }>;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: string | null;
  limit: number;
}

/**
 * Records one use and reports whether it was within the limit.
 *
 * Fails OPEN. If the counter cannot be read or written, the request proceeds.
 * That is a deliberate trade: this is abuse protection, and a database hiccup
 * refusing to transcribe a consultation in progress would be a worse outcome
 * than an unbounded window for the duration of the incident. The failure is
 * logged, so it is visible rather than silent.
 */
export async function checkRateLimit(
  client: RpcClient,
  bucket: RateLimitBucket,
): Promise<RateLimitResult> {
  const { limit, windowSeconds } = RATE_LIMITS[bucket];
  try {
    const { data, error } = await client.rpc("check_rate_limit", {
      p_bucket: bucket,
      p_limit: limit,
      p_window_seconds: windowSeconds,
    });
    if (error) {
      console.warn(`[rate-limit] ${bucket}: check failed, allowing: ${error.message}`);
      return { allowed: true, remaining: limit, resetAt: null, limit };
    }
    const row = data as { allowed: boolean; remaining: number; reset_at: string };
    return {
      allowed: Boolean(row?.allowed),
      remaining: Number(row?.remaining ?? 0),
      resetAt: row?.reset_at ?? null,
      limit,
    };
  } catch (err) {
    console.warn(`[rate-limit] ${bucket}: check threw, allowing`, err);
    return { allowed: true, remaining: limit, resetAt: null, limit };
  }
}

/** The 429 to return when a limit is reached. */
export function rateLimitedResponse(
  bucket: RateLimitBucket,
  result: RateLimitResult,
  corsHeaders: Record<string, string>,
): Response {
  const retryAfter = result.resetAt
    ? Math.max(1, Math.ceil((new Date(result.resetAt).getTime() - Date.now()) / 1000))
    : 300;

  return new Response(
    JSON.stringify({
      error:
        "You have made too many requests in a short period. " +
        "Please wait a few minutes and try again.",
      rate_limited: true,
      retry_after_seconds: retryAfter,
    }),
    {
      status: 429,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
        "Retry-After": String(retryAfter),
        "X-RateLimit-Limit": String(result.limit),
        "X-RateLimit-Remaining": "0",
      },
    },
  );
}
