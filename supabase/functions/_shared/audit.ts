/**
 * Server-side audit writes for edge functions.
 *
 * Events recorded here are the authoritative ones — a letter was generated, a
 * transcription completed, an email was accepted by the provider. The browser
 * cannot observe those reliably: it may be closed, offline, or lying.
 *
 * The write goes through the same `log_audit_event` RPC the browser uses,
 * called with the *caller's* client rather than the service role. That keeps a
 * single write path and means attribution is derived from the caller's JWT and
 * cannot be forged by a compromised function argument. Using the service role
 * here would let any bug in a function attribute an action to any user.
 *
 * Mirrors src/lib/audit.ts. The action vocabulary is asserted to match in
 * src/test/audit-trail.test.ts.
 */

/** Non-clinical context only. Mirrors the deny-list enforced by the database. */
export type AuditDetail = Record<string, string | number | boolean | null>;

export type AuditOutcome = "success" | "failure" | "denied";

export interface EdgeAuditEvent {
  action: string;
  resource?: string;
  resourceId?: string | null;
  subjectId?: string | null;
  outcome?: AuditOutcome;
  detail?: AuditDetail;
}

/** Minimal shape of the Supabase client an edge function already builds. */
interface RpcClient {
  rpc(fn: string, args: Record<string, unknown>): Promise<{ error: { message: string } | null }>;
}

/**
 * Records an event. Never throws.
 *
 * A failed audit write must not fail the clinical action that triggered it.
 * Losing a generated letter because the log was briefly unreachable would be a
 * worse outcome than a gap in the trail, and the gap is itself visible in the
 * function logs.
 */
export async function logAudit(client: RpcClient, event: EdgeAuditEvent): Promise<void> {
  try {
    const { error } = await client.rpc("log_audit_event", {
      p_action: event.action,
      p_resource: event.resource ?? null,
      p_resource_id: event.resourceId ?? null,
      p_subject_id: event.subjectId ?? null,
      p_outcome: event.outcome ?? "success",
      p_detail: event.detail ?? null,
    });
    if (error) console.warn(`[audit] write failed: ${event.action}: ${error.message}`);
  } catch (err) {
    console.warn(`[audit] write threw: ${event.action}: ${redactError(err)}`);
  }
}
