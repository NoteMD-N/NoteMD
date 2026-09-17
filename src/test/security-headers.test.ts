// @vitest-environment node
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * The response headers are part of the security posture, and they live in a
 * YAML file nobody reads. These assert the properties that matter, and — more
 * usefully — that the Content Security Policy still matches the origins the
 * application actually contacts.
 *
 * The failure mode this prevents: someone adds a call to a new third-party
 * host, it works in development (no CSP on the dev server), and breaks only in
 * production. Or the reverse, and more serious: the policy quietly grows a
 * permission nobody intended.
 */

const ROOT = join(__dirname, "../..");
const renderYaml = readFileSync(join(ROOT, "render.yaml"), "utf8");

/** Pulls one header's value out of the Blueprint, folding YAML block scalars. */
function header(name: string): string {
  const at = renderYaml.indexOf(`name: ${name}`);
  expect(at, `render.yaml does not set ${name}`).toBeGreaterThan(-1);
  const after = renderYaml.slice(at);
  const valueAt = after.indexOf("value:");
  const rest = after.slice(valueAt + "value:".length);

  // A block scalar (`>-`) continues until the next list item or header entry.
  const lines = rest.split("\n");
  const collected: string[] = [];
  const first = lines[0].replace(/^\s*>-\s*$/, "").trim();
  if (first) collected.push(first);
  for (const line of lines.slice(1)) {
    if (/^\s*-\s/.test(line) || /^\s*$/.test(line)) {
      if (collected.length) break;
      continue;
    }
    collected.push(line.trim());
  }
  return collected.join(" ").replace(/\s+/g, " ").trim();
}

function cspDirective(name: string): string[] {
  const csp = header("Content-Security-Policy");
  const part = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith(name + " "));
  return part ? part.slice(name.length).trim().split(/\s+/) : [];
}

describe("Content Security Policy", () => {
  it("does not weaken script-src", () => {
    // The production build emits one module script and no inline script, so
    // the strict value is achievable. This is the directive that constrains
    // XSS; everything else in the policy is secondary to it.
    const scriptSrc = cspDirective("script-src");
    expect(scriptSrc).toEqual(["'self'"]);
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
  });

  it("keeps the build free of inline scripts, which is what allows that", () => {
    // If a build ever emitted an inline script, the strict script-src above
    // would break the app in production and pass every test here. Check the
    // built output directly.
    const dist = join(ROOT, "dist");
    let html: string;
    try {
      html = readFileSync(join(dist, "index.html"), "utf8");
    } catch {
      return; // not built in this run
    }
    const inline = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)]
      .map((m) => m[1].trim())
      .filter(Boolean);
    expect(inline, "an inline script would be blocked by script-src 'self'").toEqual([]);
  });

  it("allows exactly the origins the application contacts", () => {
    const connect = cspDirective("connect-src");
    for (const origin of [
      "'self'",
      "https://*.supabase.co",
      "wss://*.supabase.co",
      "https://api.eu.deepgram.com",
      "wss://api.eu.deepgram.com",
    ]) {
      expect(connect, `connect-src is missing ${origin}`).toContain(origin);
    }
  });

  it("does not permit the non-EU transcription endpoint", () => {
    // The browser streams consultation audio directly to Deepgram, so leaving
    // the global host out of connect-src makes EU residency enforceable at the
    // browser rather than only at the server that mints the token.
    const connect = cspDirective("connect-src");
    expect(connect).not.toContain("https://api.deepgram.com");
    expect(connect).not.toContain("wss://api.deepgram.com");
    expect(connect.some((o) => o === "*" || o === "https:" || o === "wss:")).toBe(false);
  });

  it("forbids framing, plugins and base tag injection", () => {
    expect(cspDirective("frame-ancestors")).toEqual(["'none'"]);
    expect(cspDirective("object-src")).toEqual(["'none'"]);
    expect(cspDirective("base-uri")).toEqual(["'self'"]);
    expect(cspDirective("form-action")).toEqual(["'self'"]);
  });

  it("has a default-src fallback", () => {
    expect(cspDirective("default-src")).toEqual(["'self'"]);
  });
});

describe("transport and isolation headers", () => {
  it("sets HSTS for at least a year, including subdomains", () => {
    const hsts = header("Strict-Transport-Security");
    const maxAge = Number(hsts.match(/max-age=(\d+)/)?.[1] ?? 0);
    expect(maxAge).toBeGreaterThanOrEqual(31536000);
    expect(hsts).toContain("includeSubDomains");
  });

  it("sets the remaining hardening headers", () => {
    expect(header("X-Content-Type-Options")).toBe("nosniff");
    expect(header("X-Frame-Options")).toBe("DENY");
    expect(header("Referrer-Policy")).toMatch(/strict-origin|no-referrer/);
    expect(header("Cross-Origin-Opener-Policy")).toBe("same-origin");
  });

  it("grants the microphone only to this origin and denies the rest", () => {
    const pp = header("Permissions-Policy");
    // Dictation needs it; nothing else should be available to a compromised
    // script or an embedded frame.
    expect(pp).toMatch(/microphone=\(self\)/);
    expect(pp).toMatch(/camera=\(\)/);
    expect(pp).toMatch(/geolocation=\(\)/);
    expect(pp).toMatch(/display-capture=\(\)/);
  });
});

describe("hosting shape", () => {
  it("is a static site, so no server can observe clinical request bodies", () => {
    expect(renderYaml).toMatch(/env: static/);
    expect(renderYaml).not.toMatch(/env: node/);
    expect(renderYaml).not.toMatch(/startCommand:/);
  });

  it("rewrites unknown paths to the SPA entry rather than redirecting", () => {
    // A 301 redirect breaks client-side routing; this was a real bug once.
    expect(renderYaml).toMatch(/type: rewrite[\s\S]*?destination: \/index\.html/);
  });
});

describe("no new external origin has been introduced without updating the CSP", () => {
  it("cross-checks client source against connect-src", () => {
    const connect = cspDirective("connect-src");
    const srcDir = join(ROOT, "src");

    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry.name) && !full.includes("/test/")) files.push(full);
      }
    };
    walk(srcDir);

    const allowed = new Set([
      // Not a network origin — the SVG namespace identifier.
      "www.w3.org",
      // Stylesheet and font hosts are covered by style-src and font-src.
      "fonts.googleapis.com",
      "fonts.gstatic.com",
      // Documentation and placeholder values.
      "example.com",
      // Named in the residency policy so the EU host can be compared against
      // it; the browser never connects here, and the CSP forbids it.
      "api.deepgram.com",
    ]);

    const offenders: string[] = [];
    for (const file of files) {
      const body = readFileSync(file, "utf8");
      for (const match of body.matchAll(/(?:https|wss):\/\/([a-zA-Z0-9.-]+\.[a-z]{2,})/g)) {
        const host = match[1];
        if (allowed.has(host)) continue;
        const covered = connect.some((origin) => {
          const bare = origin.replace(/^(https|wss):\/\//, "");
          if (bare.startsWith("*.")) return host.endsWith(bare.slice(1));
          return bare === host;
        });
        if (!covered) offenders.push(`${host} (${file.replace(ROOT + "/", "")})`);
      }
    }

    expect(
      [...new Set(offenders)],
      "these hosts appear in client source but are not permitted by connect-src",
    ).toEqual([]);
  });
});
