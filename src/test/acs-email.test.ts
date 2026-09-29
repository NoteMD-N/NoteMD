// @vitest-environment node
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  idempotencyKeyFor,
  parseConnectionString,
  resolveAcsConfig,
  sendUrl,
  signRequest,
  signedHeaders,
  stringToSign,
} from "../../supabase/functions/_shared/acs-email.ts";

/**
 * Azure Communication Services signs every request with HMAC-SHA256 over a
 * string assembled from the method, path and query, date, host, and a hash of
 * the body. Any mistake in that assembly — a trailing slash, the wrong date
 * format, a body hashed after it changed by one byte — returns 401, which
 * reads exactly like a bad access key and sends you looking in the wrong
 * place.
 *
 * The signature below was derived independently, in Python, from the same
 * inputs. That makes this a cross-check against the algorithm rather than a
 * restatement of whatever this implementation happens to do, which matters
 * because it is being written before a live key exists to try it against.
 */

const KEY = "dGVzdC1hY2Nlc3Mta2V5LW1hdGVyaWFs";
const HOST = "emails-notemd.uk.communication.azure.com";
const PATH = "/emails:send?api-version=2023-03-31";
const DATE = "Mon, 29 Sep 2026 10:00:00 GMT";
const BODY = '{"senderAddress":"DoNotReply@example.azurecomm.net"}';
const BODY_HASH = "USRNaqkEMxsy4DBVuZt0zHdRSJRxetkT1b3up+qGqhA=";
const EXPECTED_SIGNATURE = "VnyPosNKKi3TTmzZ/WdDDA0NQYHLUvCuJmHbi+lEoaM=";

describe("request signing", () => {
  it("builds the exact string ACS signs", () => {
    expect(stringToSign("POST", PATH, DATE, HOST, BODY_HASH)).toBe(
      `POST\n${PATH}\n${DATE};${HOST};${BODY_HASH}`,
    );
  });

  it("produces the signature an independent implementation produces", async () => {
    const sig = await signRequest(KEY, stringToSign("POST", PATH, DATE, HOST, BODY_HASH));
    expect(sig).toBe(EXPECTED_SIGNATURE);
  });

  it("changes the signature when the body changes by one character", async () => {
    // Proves the body is genuinely covered by the signature, rather than the
    // hash being computed and then not used.
    const a = await signedHeaders(
      { endpoint: `https://${HOST}`, accessKey: KEY, senderAddress: "x@y.z" },
      "POST",
      new URL(`https://${HOST}${PATH}`),
      BODY,
    );
    const b = await signedHeaders(
      { endpoint: `https://${HOST}`, accessKey: KEY, senderAddress: "x@y.z" },
      "POST",
      new URL(`https://${HOST}${PATH}`),
      BODY + " ",
    );
    expect(a["x-ms-content-sha256"]).not.toBe(b["x-ms-content-sha256"]);
    expect(a.Authorization).not.toBe(b.Authorization);
  });

  it("signs the same date it sends", async () => {
    // ACS rejects a request whose date drifts from the signed value, and the
    // failure is a 401 that looks like a credentials problem.
    const headers = await signedHeaders(
      { endpoint: `https://${HOST}`, accessKey: KEY, senderAddress: "x@y.z" },
      "POST",
      new URL(`https://${HOST}${PATH}`),
      BODY,
    );
    const expected = await signRequest(
      KEY,
      stringToSign("POST", PATH, headers["x-ms-date"], HOST, headers["x-ms-content-sha256"]),
    );
    expect(headers.Authorization).toContain(expected);
  });

  it("declares exactly the headers it signed", () => {
    // The SignedHeaders list has to match what was actually hashed, in order.
    return signedHeaders(
      { endpoint: `https://${HOST}`, accessKey: KEY, senderAddress: "x@y.z" },
      "POST",
      new URL(`https://${HOST}${PATH}`),
      BODY,
    ).then((h) => {
      expect(h.Authorization).toMatch(
        /^HMAC-SHA256 SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature=/,
      );
      expect(h["x-ms-date"]).toMatch(/GMT$/);
    });
  });

  it("uses an RFC 1123 GMT date", async () => {
    const h = await signedHeaders(
      { endpoint: `https://${HOST}`, accessKey: KEY, senderAddress: "x@y.z" },
      "GET",
      new URL(`https://${HOST}/emails/operations/abc?api-version=2023-03-31`),
      "",
    );
    expect(h["x-ms-date"]).toMatch(
      /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/,
    );
  });
});

describe("connection string", () => {
  const ENDPOINT = "https://emails-notemd.uk.communication.azure.com";

  it("parses the shape the portal hands out", () => {
    expect(parseConnectionString(`endpoint=${ENDPOINT}/;accesskey=${KEY}`)).toEqual({
      endpoint: ENDPOINT,
      accessKey: KEY,
    });
  });

  it("accepts the parts in either order and ignores case", () => {
    expect(parseConnectionString(`AccessKey=${KEY};Endpoint=${ENDPOINT}`)).toEqual({
      endpoint: ENDPOINT,
      accessKey: KEY,
    });
  });

  it("keeps the base64 padding on the key", () => {
    // The key contains "=" characters. Splitting on every "=" instead of the
    // first truncates it, and the result is a 401 rather than a parse error.
    const padded = "YWJjZA==";
    expect(parseConnectionString(`endpoint=${ENDPOINT};accesskey=${padded}`)?.accessKey).toBe(
      padded,
    );
  });

  it("rejects anything incomplete rather than half-configuring", () => {
    expect(parseConnectionString("")).toBeNull();
    expect(parseConnectionString(`endpoint=${ENDPOINT}`)).toBeNull();
    expect(parseConnectionString(`accesskey=${KEY}`)).toBeNull();
    expect(parseConnectionString(`endpoint=ftp://x;accesskey=${KEY}`)).toBeNull();
  });
});

describe("configuration", () => {
  const env = (vars: Record<string, string>) => (k: string) => vars[k];
  const CONN = "endpoint=https://emails-notemd.uk.communication.azure.com/;accesskey=" + KEY;

  it("is inactive until both the connection string and sender exist", () => {
    // A half-configured ACS must leave the existing provider in place rather
    // than take clinical email down.
    expect(resolveAcsConfig(env({}))).toBeNull();
    expect(resolveAcsConfig(env({ ACS_CONNECTION_STRING: CONN }))).toBeNull();
    expect(resolveAcsConfig(env({ ACS_SENDER_ADDRESS: "a@b.c" }))).toBeNull();
  });

  it("activates once both are present", () => {
    const cfg = resolveAcsConfig(
      env({ ACS_CONNECTION_STRING: CONN, ACS_SENDER_ADDRESS: "DoNotReply@x.azurecomm.net" }),
    );
    expect(cfg?.endpoint).toBe("https://emails-notemd.uk.communication.azure.com");
    expect(cfg?.senderAddress).toBe("DoNotReply@x.azurecomm.net");
  });

  it("builds the send URL with the API version", () => {
    const cfg = {
      endpoint: "https://emails-notemd.uk.communication.azure.com",
      accessKey: KEY,
      senderAddress: "x@y.z",
    };
    expect(sendUrl(cfg).toString()).toBe(
      "https://emails-notemd.uk.communication.azure.com/emails:send?api-version=2023-03-31",
    );
  });
});

describe("idempotency keys", () => {
  it("is stable for the same send", async () => {
    // A retry, or a double submit that got past the UI guard, must be one
    // operation. Clinical correspondence cannot be recalled.
    const a = await idempotencyKeyFor(["letter-1", "gp@example.nhs.uk", "Dear colleague"]);
    const b = await idempotencyKeyFor(["letter-1", "gp@example.nhs.uk", "Dear colleague"]);
    expect(a).toBe(b);
  });

  it("changes when the content changes, so a deliberate resend is allowed", async () => {
    const before = await idempotencyKeyFor(["letter-1", "gp@example.nhs.uk", "Dear colleague"]);
    const after = await idempotencyKeyFor(["letter-1", "gp@example.nhs.uk", "Dear colleague,"]);
    expect(after).not.toBe(before);
  });

  it("changes when the recipients change", async () => {
    const a = await idempotencyKeyFor(["letter-1", "gp@example.nhs.uk", "body"]);
    const b = await idempotencyKeyFor(["letter-1", "other@example.nhs.uk", "body"]);
    expect(a).not.toBe(b);
  });

  it("cannot be confused by a field boundary", async () => {
    // Joining on a separator that can appear in the data would make these two
    // identical, and one letter would suppress another.
    const a = await idempotencyKeyFor(["letter-1", "a@x.uk,b@x.uk", "body"]);
    const b = await idempotencyKeyFor(["letter-1,a@x.uk", "b@x.uk", "body"]);
    expect(a).not.toBe(b);
  });

  it("is a well-formed version 4 UUID, which ACS validates", async () => {
    const key = await idempotencyKeyFor(["letter-1", "gp@example.nhs.uk", "body"]);
    expect(key).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe("both email functions use the provider selection", () => {
  const read = (p: string) =>
    readFileSync(join(__dirname, "../../supabase/functions", p, "index.ts"), "utf8");

  for (const fn of ["send-letter-email", "send-transcript-email"]) {
    it(`${fn} treats either provider as configured`, () => {
      // Checking only Resend would report "not configured" on an ACS-only
      // deployment and never reach the sending code.
      const src = read(fn);
      expect(src).toMatch(/if \(!acs && \(!RESEND_API_KEY \|\| !FROM_ADDRESS\)\)/);
    });

    it(`${fn} sends an idempotency key`, () => {
      expect(read(fn)).toMatch(/idempotencyKeyFor\(/);
    });
  }

  it("send-letter-email resolves delivery before reporting success", () => {
    // A 202 from ACS means accepted, not delivered.
    const src = read("send-letter-email");
    expect(src).toMatch(/pollDelivery\(/);
    expect(src).toMatch(/delivery_status/);
  });
});
