/**
 * Azure Communication Services Email.
 *
 * ACS does not authenticate with a bearer token or an API key header. Each
 * request is signed with HMAC-SHA256 over a string built from the method, the
 * path and query, the date, the host, and a hash of the body. Get any part of
 * that string wrong — a trailing slash, the wrong date format, the body hashed
 * after serialisation differs by a byte — and the service returns 401, which
 * reads exactly like a bad key. That is why the signing lives here, alone,
 * with tests against a fixed vector.
 *
 * Sending is asynchronous: the send call returns 202 with an operation id, and
 * the delivery outcome is polled separately. A 202 therefore means "accepted
 * for delivery", not "delivered", and the two must not be reported to a
 * clinician as the same thing.
 *
 * Note for the record: Microsoft has announced the retirement of Azure
 * Communication Services as a standalone offering, effective 30 September
 * 2028, and ACS Email is on the retired list. The client has chosen to proceed
 * on ACS with that known. The provider-specific parts are confined to this
 * file so that a later move costs the two call sites and nothing else.
 */

export interface AcsConfig {
  /** Base URL with no trailing slash, e.g. https://x.uk.communication.azure.com */
  endpoint: string;
  /** Raw (base64) access key from the connection string. */
  accessKey: string;
  /** Verified sender, e.g. DoNotReply@<guid>.azurecomm.net */
  senderAddress: string;
}

export interface AcsRecipient {
  address: string;
  displayName?: string;
}

export interface AcsMessage {
  to: AcsRecipient[];
  subject: string;
  plainText: string;
  html?: string;
  /**
   * Stable identifier for this logical send. ACS treats two requests carrying
   * the same value as the same operation, which is what stops a retry — or a
   * double click that got past the UI guard — producing a second copy of a
   * clinical letter.
   */
  idempotencyKey: string;
  /**
   * When this send was first attempted. Reused across retries so the
   * provider's repeatability headers can match; regenerating it defeats them,
   * which is what happened on the first live test.
   */
  firstSentAt?: string;
}

export interface AcsSendResult {
  /** Accepted for delivery. Not the same as delivered. */
  accepted: boolean;
  status: number;
  /** ACS operation id, for polling the delivery outcome. */
  operationId: string | null;
  /** Absolute URL to poll for the delivery outcome. */
  operationLocation: string | null;
  /** Redacted diagnostic detail when the request was refused. */
  error: string | null;
}

const API_VERSION = "2023-03-31";

type Env = (name: string) => string | undefined;

/**
 * Reads ACS configuration from the environment.
 *
 * Returns null unless everything needed is present. A half-configured ACS must
 * leave the existing provider in place rather than take clinical email down.
 */
export function resolveAcsConfig(env: Env): AcsConfig | null {
  const connection = (env("ACS_CONNECTION_STRING") || "").trim();
  const senderAddress = (env("ACS_SENDER_ADDRESS") || "").trim();
  if (!connection || !senderAddress) return null;

  const parsed = parseConnectionString(connection);
  if (!parsed) return null;

  return { ...parsed, senderAddress };
}

/**
 * Splits `endpoint=https://...;accesskey=...` into its parts.
 *
 * The portal presents this as one opaque string, so it arrives pasted, often
 * with the order reversed or a stray trailing semicolon. Both orders are
 * accepted and the key names are matched case-insensitively.
 */
export function parseConnectionString(
  value: string,
): { endpoint: string; accessKey: string } | null {
  let endpoint = "";
  let accessKey = "";

  for (const part of value.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 1) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    // The key is base64 and contains "=" padding, so only split on the first.
    const val = part.slice(eq + 1).trim();
    if (key === "endpoint") endpoint = val.replace(/\/+$/, "");
    else if (key === "accesskey") accessKey = val;
  }

  if (!endpoint || !accessKey) return null;
  if (!/^https:\/\//i.test(endpoint)) return null;

  // Reject a key that cannot be a real one.
  //
  // A connection string is pasted from the portal, often out of a command
  // example, and a truncated or placeholder value parses perfectly happily —
  // it is simply a short string. Treating that as configured would switch
  // live email to a provider that rejects every request, which is worse than
  // not being configured at all. An ACS access key is base64 and long; a
  // placeholder such as "…" or "<key>" is neither.
  if (!isPlausibleAccessKey(accessKey)) return null;

  return { endpoint, accessKey };
}

/**
 * Whether a value could be a real ACS access key.
 *
 * Deliberately a shape check rather than a verification: the only way to know
 * a key is correct is to use it, and that cannot be done while deciding
 * whether to be configured at all. This catches the failure that actually
 * happens — a placeholder or a truncated paste — not a wrong-but-well-formed
 * key, which fails visibly on first use.
 */
export function isPlausibleAccessKey(value: string): boolean {
  const key = value.trim();
  // A real ACS key is base64 of a 32-byte secret, so 44 characters or more.
  // The floor is set below that rather than at it: the purpose is to catch
  // placeholders and truncated pastes, not to encode an assumption about key
  // length that a future format change could invalidate.
  if (key.length < 32) return false;
  if (!/^[A-Za-z0-9+/=]+$/.test(key)) return false;
  return true;
}

/** Base64 of the SHA-256 digest of the exact bytes being sent. */
async function contentHash(body: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return base64(new Uint8Array(digest));
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * The string ACS signs, and the signature over it.
 *
 * Exported so the exact bytes can be asserted in tests: this is the part that
 * fails silently and expensively, and comparing it against a known vector is
 * the only way to be sure before a live key exists.
 */
export function stringToSign(
  method: string,
  pathAndQuery: string,
  dateHeader: string,
  host: string,
  bodyHash: string,
): string {
  return `${method}\n${pathAndQuery}\n${dateHeader};${host};${bodyHash}`;
}

export async function signRequest(
  accessKey: string,
  toSign: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    fromBase64(accessKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(toSign),
  );
  return base64(new Uint8Array(signature));
}

/**
 * Headers for a signed ACS request.
 *
 * `x-ms-date` must be RFC 1123 in GMT and must be the same value that was
 * signed; ACS rejects a request whose date is more than a few minutes from its
 * own clock, so the value is generated once and reused rather than recomputed.
 */
export async function signedHeaders(
  cfg: AcsConfig,
  method: string,
  url: URL,
  body: string,
  extra: Record<string, string> = {},
): Promise<Record<string, string>> {
  const date = new Date().toUTCString();
  const hash = await contentHash(body);
  const pathAndQuery = `${url.pathname}${url.search}`;
  const signature = await signRequest(
    cfg.accessKey,
    stringToSign(method, pathAndQuery, date, url.host, hash),
  );

  return {
    "x-ms-date": date,
    "x-ms-content-sha256": hash,
    "Content-Type": "application/json",
    Authorization:
      `HMAC-SHA256 SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature=${signature}`,
    ...extra,
  };
}

/**
 * A stable, UUID-shaped key for one logical send.
 *
 * Azure's repeatability headers expect a UUID, and the value must be identical
 * across a retry of the same send but different for a deliberate one. Deriving
 * it from the record, the recipients and the content gives both: pressing send
 * twice on the same letter is one operation, while re-sending after an edit is
 * a new one.
 */
export async function idempotencyKeyFor(parts: string[]): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(parts.join("\u0000")),
  );
  const hex = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    // Version 4 nibble, so the value is a well-formed UUID rather than merely
    // UUID-shaped; ACS validates the format.
    "4" + hex.slice(13, 16),
    ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16) + hex.slice(17, 20),
    hex.slice(20, 32),
  ].join("-");
}

export function sendUrl(cfg: AcsConfig): URL {
  return new URL(`${cfg.endpoint}/emails:send?api-version=${API_VERSION}`);
}

/**
 * Submits a message for delivery.
 *
 * A 202 means ACS has accepted it, not that anyone received it. The caller
 * gets the operation id so the outcome can be resolved before anything is
 * reported to the clinician as sent.
 */
export async function sendEmail(
  cfg: AcsConfig,
  message: AcsMessage,
  redact: (body: string) => string,
): Promise<AcsSendResult> {
  const url = sendUrl(cfg);
  const body = JSON.stringify({
    senderAddress: cfg.senderAddress,
    content: {
      subject: message.subject,
      plainText: message.plainText,
      ...(message.html ? { html: message.html } : {}),
    },
    recipients: {
      to: message.to.map((r) => ({
        address: r.address,
        ...(r.displayName ? { displayName: r.displayName } : {}),
      })),
    },
  });

  // Repeatability headers are what make a retry safe. Without them an ACS
  // retry after a timeout can deliver the same letter twice, and clinical
  // correspondence cannot be recalled.
  const headers = await signedHeaders(cfg, "POST", url, body, {
    "Repeatability-Request-ID": message.idempotencyKey,
    "Repeatability-First-Sent": message.firstSentAt
      ? new Date(message.firstSentAt).toUTCString()
      : new Date().toUTCString(),
  });

  const resp = await fetch(url.toString(), { method: "POST", headers, body });
  const text = await resp.text();

  if (!resp.ok) {
    return {
      accepted: false,
      status: resp.status,
      operationId: null,
      operationLocation: null,
      error: redact(text),
    };
  }

  let operationId: string | null = null;
  try {
    operationId = (JSON.parse(text) as { id?: string }).id ?? null;
  } catch {
    /* 202 with an empty body is valid; the header still carries the location */
  }

  return {
    accepted: true,
    status: resp.status,
    operationId: operationId ?? resp.headers.get("x-ms-request-id"),
    operationLocation: resp.headers.get("operation-location"),
    error: null,
  };
}

export type AcsDeliveryStatus =
  | "NotStarted"
  | "Running"
  | "Succeeded"
  | "Failed"
  | "Unknown";

/**
 * Resolves the outcome of a submitted message.
 *
 * Polled rather than awaited indefinitely: a clinician should not be left
 * waiting on a mail server, and "still sending" is a truthful answer that the
 * audit trail can record.
 */
export async function pollDelivery(
  cfg: AcsConfig,
  operationLocation: string,
  redact: (body: string) => string,
  attempts = 4,
  delayMs = 750,
): Promise<{ status: AcsDeliveryStatus; error: string | null }> {
  const url = new URL(operationLocation);

  for (let i = 0; i < attempts; i++) {
    const headers = await signedHeaders(cfg, "GET", url, "");
    const resp = await fetch(url.toString(), { method: "GET", headers });
    const text = await resp.text();

    if (!resp.ok) return { status: "Unknown", error: redact(text) };

    let parsed: { status?: string; error?: unknown } = {};
    try {
      parsed = JSON.parse(text);
    } catch {
      return { status: "Unknown", error: null };
    }

    const status = (parsed.status ?? "Unknown") as AcsDeliveryStatus;
    if (status === "Succeeded") return { status, error: null };
    if (status === "Failed") return { status, error: redact(text) };

    if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
  }

  // Still in flight. Not a failure — the audit entry records it as pending.
  return { status: "Running", error: null };
}
