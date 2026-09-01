// @vitest-environment node
import { describe, it, expect } from "vitest";
import { letterRoute, letterIdFromHash, LETTER_PATH } from "@/lib/letter-route";

/**
 * The letter identifier is held in the URL fragment rather than the path.
 *
 * Browsers do not transmit the fragment in an HTTP request, so the static host
 * receives only "/letter" and the identifier cannot reach its access logs.
 * Referrer headers also omit the fragment, so it cannot leak cross-origin.
 */

const ID = "3f8a1c2e-9b4d-4e77-8a11-5c6d7e8f9a0b";

describe("letterRoute", () => {
  it("puts the identifier after the fragment marker, never in the path", () => {
    const route = letterRoute(ID);
    expect(route).toBe(`${LETTER_PATH}#${ID}`);

    // The path portion — everything the server would receive — must not
    // contain the identifier.
    const pathPortion = route.split("#")[0];
    expect(pathPortion).toBe(LETTER_PATH);
    expect(pathPortion).not.toContain(ID);
  });

  it("produces a path with no query string either", () => {
    // A query string IS sent to the server, so it would defeat the purpose.
    expect(letterRoute(ID)).not.toContain("?");
  });
});

describe("letterIdFromHash", () => {
  it("reads the identifier with or without the leading marker", () => {
    expect(letterIdFromHash(`#${ID}`)).toBe(ID);
    expect(letterIdFromHash(ID)).toBe(ID);
  });

  it("round-trips a generated route", () => {
    const hash = letterRoute(ID).split("#")[1];
    expect(letterIdFromHash(hash)).toBe(ID);
  });

  it("returns null for an absent fragment", () => {
    for (const v of ["", "#", "   ", null, undefined]) {
      expect(letterIdFromHash(v)).toBeNull();
    }
  });

  it("rejects anything that is not a valid identifier", () => {
    // Guards against a crafted fragment being passed into a query.
    for (const bad of [
      "not-a-uuid",
      "../../etc/passwd",
      "' OR 1=1--",
      "<script>alert(1)</script>",
      "3f8a1c2e-9b4d-4e77-8a11",           // truncated
      `${ID} OR true`,
    ]) {
      expect(letterIdFromHash(bad), `should reject: ${bad}`).toBeNull();
    }
  });

  it("does not throw on malformed percent-encoding", () => {
    expect(() => letterIdFromHash("%E0%A4%A")).not.toThrow();
    expect(letterIdFromHash("%E0%A4%A")).toBeNull();
  });
});

describe("no letter identifier can reach the server", () => {
  it("the route the browser requests contains no identifier", () => {
    // What a browser sends is everything before the "#".
    const requested = letterRoute(ID).split("#")[0];
    expect(requested).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i);
  });
});
