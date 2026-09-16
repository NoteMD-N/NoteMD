/**
 * Clinical audit trail.
 *
 * Every entry answers: who did what, against which record, when, and with
 * what result. It never carries clinical content — the trail records that a
 * letter was generated, not what the letter said. `processing_audit_log` has
 * a CHECK constraint enforcing that, so a call site cannot quietly start
 * copying transcripts into `detail`; this module exists so call sites do not
 * try in the first place.
 *
 * Writes go through the `log_audit_event` RPC rather than an INSERT. The
 * function derives the actor from the session, so attribution cannot be
 * forged by a caller that tampers with its own request.
 */
import { supabase } from "@/integrations/supabase/client";

/**
 * The canonical event vocabulary.
 *
 * Kept as a closed set so the audit trail is queryable and so the assurance
 * evidence can state exactly which events are captured. Adding an event means
 * adding it here, which keeps `docs/` and the code in step.
 */
export const AUDIT_ACTIONS = {
  // Authentication and session
  LOGIN: "auth.login",
  LOGIN_FAILED: "auth.login_failed",
  LOGOUT: "auth.logout",
  SESSION_EXPIRED: "auth.session_expired",
  SESSION_TIMEOUT: "auth.session_timeout_inactivity",
  MFA_ENROLLED: "auth.mfa_enrolled",
  MFA_UNENROLLED: "auth.mfa_unenrolled",
  MFA_CHALLENGE_PASSED: "auth.mfa_challenge_passed",
  MFA_CHALLENGE_FAILED: "auth.mfa_challenge_failed",
  PASSWORD_RESET_REQUESTED: "auth.password_reset_requested",
  PASSWORD_CHANGED: "auth.password_changed",

  // Clinical records
  RECORDING_CREATED: "recording.created",
  RECORDING_VIEWED: "recording.viewed",
  RECORDING_UPDATED: "recording.updated",
  RECORDING_DELETED: "recording.deleted",
  RECORDING_DISCARDED: "recording.discarded",
  TRANSCRIPTION_STARTED: "transcription.started",
  TRANSCRIPTION_COMPLETED: "transcription.completed",
  TRANSCRIPTION_FAILED: "transcription.failed",

  // Letters
  LETTER_GENERATED: "letter.generated",
  LETTER_REGENERATED: "letter.regenerated",
  LETTER_VIEWED: "letter.viewed",
  LETTER_EDITED: "letter.edited",
  LETTER_REVIEWED: "letter.reviewed",
  LETTER_DELETED: "letter.deleted",
  LETTER_EXPORTED: "letter.exported",
  LETTER_COPIED: "letter.copied",
  LETTER_EMAILED: "letter.emailed",
  LETTER_EMAIL_FAILED: "letter.email_failed",

  // Administration and account
  SECRETARY_ADDED: "admin.secretary_added",
  SECRETARY_REMOVED: "admin.secretary_removed",
  SETTINGS_UPDATED: "admin.settings_updated",
  TEMPLATE_CREATED: "admin.template_created",
  TEMPLATE_UPDATED: "admin.template_updated",
  TEMPLATE_DELETED: "admin.template_deleted",

  // Data subject rights
  PATIENT_DATA_SEARCHED: "gdpr.patient_searched",
  PATIENT_DATA_EXPORTED: "gdpr.patient_exported",
  PATIENT_DATA_ERASED: "gdpr.patient_erased",
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

export type AuditOutcome = "success" | "failure" | "denied";

export interface AuditEvent {
  action: AuditAction;
  /** The kind of record acted upon, e.g. "letter", "recording". */
  resource?: string;
  /** The record's id, where one exists. */
  resourceId?: string;
  /**
   * Whose record this is, when that differs from the actor — a secretary
   * acting on their clinician's record. Defaults to the actor.
   */
  subjectId?: string;
  outcome?: AuditOutcome;
  /**
   * Non-clinical context only: counts, durations, reasons, template names,
   * error codes. Never transcripts, letter text, or patient identifiers.
   */
  detail?: Record<string, string | number | boolean | null>;
}

/**
 * Keys the database constraint rejects. Checked here too so a mistake shows
 * up in development as a console warning against the offending call site,
 * rather than as a silently dropped `detail` in production.
 */
const FORBIDDEN_DETAIL_KEYS = new Set([
  "transcript", "transcript_text", "raw_transcript", "letter", "letter_content",
  "content", "body", "text", "audio", "audio_data", "prompt", "completion",
  "message", "messages", "patient_name", "patient_id", "nhs_number", "dob",
  "date_of_birth", "address", "phone", "telephone", "email",
]);

function sanitiseDetail(detail?: AuditEvent["detail"]): AuditEvent["detail"] | null {
  if (!detail) return null;
  const clean: NonNullable<AuditEvent["detail"]> = {};
  for (const [key, value] of Object.entries(detail)) {
    if (FORBIDDEN_DETAIL_KEYS.has(key.toLowerCase())) {
      if (import.meta.env.DEV) {
        console.warn(
          `[audit] dropped "${key}" — clinical content and patient identifiers ` +
            `must not enter the audit log.`,
        );
      }
      continue;
    }
    clean[key] = value;
  }
  return Object.keys(clean).length > 0 ? clean : null;
}

/**
 * Records an event. Never throws and never rejects.
 *
 * An audit write failing must not take a clinical action down with it — a
 * clinician losing a letter because the log was unreachable would be a worse
 * outcome than a gap in the trail. Failures are surfaced in the console and,
 * because the write is server-side, are visible in Supabase logs.
 */
export async function logAudit(event: AuditEvent): Promise<void> {
  try {
    const { error } = await supabase.rpc("log_audit_event", {
      p_action: event.action,
      p_resource: event.resource ?? null,
      p_resource_id: event.resourceId ?? null,
      p_subject_id: event.subjectId ?? null,
      p_outcome: event.outcome ?? "success",
      p_detail: sanitiseDetail(event.detail),
    });
    if (error) {
      console.warn("[audit] write failed", event.action, error.message);
    }
  } catch (err) {
    console.warn("[audit] write threw", event.action, err);
  }
}

/**
 * Fire-and-forget form, for call sites in render or event handlers where
 * awaiting the write would add latency to a clinical interaction.
 */
export function auditAsync(event: AuditEvent): void {
  void logAudit(event);
}
