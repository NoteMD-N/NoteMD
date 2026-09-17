/**
 * Reads the response headers out of render.yaml.
 *
 * render.yaml is the source of truth because Render is what serves them. This
 * exists so `vite preview` can serve the same set, which makes the Content
 * Security Policy verifiable locally: a policy that silently breaks dictation
 * or font loading is worse than no policy, and that is only discoverable by
 * loading the app with the policy applied.
 *
 * Deliberately a small purpose-built reader rather than a YAML dependency —
 * it handles exactly the one shape this file uses, and refuses anything else.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** @returns {Record<string, string>} header name -> value */
export function renderHeaders(yamlPath = join(ROOT, "render.yaml")) {
  const lines = readFileSync(yamlPath, "utf8").split("\n");
  const headers = {};

  let name = null;
  let parts = [];
  let inBlock = false;
  // `name:` also appears on the service itself, where it would pair with the
  // next `value:` (NODE_VERSION's). Only read inside the headers: block.
  let inHeaders = false;

  const flush = () => {
    if (name) headers[name] = parts.join(" ").replace(/\s+/g, " ").trim();
    name = null;
    parts = [];
    inBlock = false;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    if (/^headers:\s*$/.test(trimmed)) {
      inHeaders = true;
      continue;
    }
    // Any other top-level-ish key at or above the headers key ends the block.
    if (inHeaders && /^(services|envVars|routes|type|env|buildCommand|staticPublishPath):/.test(trimmed)) {
      flush();
      inHeaders = false;
      continue;
    }
    if (!inHeaders) continue;

    const nameMatch = trimmed.match(/^-?\s*name:\s*(\S+)$/);
    // `- key: NODE_VERSION` entries under envVars also match `name:`; only
    // treat it as a header once a `value:` follows in the header block.
    if (nameMatch && !inBlock) {
      flush();
      name = nameMatch[1];
      continue;
    }

    if (name && /^value:/.test(trimmed)) {
      const rest = trimmed.slice("value:".length).trim();
      if (rest === ">-" || rest === ">" || rest === "|") {
        inBlock = true;
      } else {
        parts.push(rest);
        const captured = name;
        const value = parts.join(" ");
        flush();
        headers[captured] = value.replace(/\s+/g, " ").trim();
      }
      continue;
    }

    if (inBlock) {
      if (/^-\s/.test(trimmed) || /^(path|name|value):/.test(trimmed)) {
        flush();
        const again = trimmed.match(/^-?\s*name:\s*(\S+)$/);
        if (again) name = again[1];
      } else {
        parts.push(trimmed);
      }
    }
  }
  flush();

  delete headers["/*"];
  return headers;
}
