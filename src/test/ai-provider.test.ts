// @vitest-environment node
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  authHeaders,
  chatCompletionsUrl,
  processingRegion,
  resolveAiConfig,
  transcriptionsUrl,
} from "../../supabase/functions/_shared/ai-provider.ts";

/**
 * OpenAI and Azure OpenAI differ in exactly three places — the URL shape, the
 * auth header, and whether the name identifies a model or a deployment. Two of
 * those fail in ways that point somewhere else entirely:
 *
 *  - A missing api-version returns 404, which reads as a bad endpoint.
 *  - A wrong deployment name returns 404 DeploymentNotFound.
 *
 * The header is the documented one for Azure. The live Foundry resource also
 * accepts a bearer token, but a classic Azure OpenAI resource does not, so the
 * module should not rely on that.
 *
 * These pin the shapes so the migration is a configuration change rather than
 * a debugging session.
 */

const env = (vars: Record<string, string>) => (k: string) => vars[k];

const AZURE = {
  AZURE_OPENAI_ENDPOINT: "https://notemd-eu.services.ai.azure.com/",
  AZURE_OPENAI_API_KEY: "azure-key",
};

describe("provider selection", () => {
  it("uses OpenAI when Azure is not configured", () => {
    const cfg = resolveAiConfig(env({ OPENAI_API_KEY: "sk-test" }));
    expect(cfg.provider).toBe("openai");
    expect(cfg.base).toBe("https://api.openai.com/v1");
  });

  it("uses Azure once an endpoint and key are both present", () => {
    // The migration is a deployment step, not a release.
    expect(resolveAiConfig(env(AZURE)).provider).toBe("azure");
  });

  it("falls back to OpenAI when Azure is only half configured", () => {
    // A partial rollout must not take letter generation down.
    const cfg = resolveAiConfig(env({ AZURE_OPENAI_ENDPOINT: AZURE.AZURE_OPENAI_ENDPOINT }));
    expect(cfg.provider).toBe("openai");
  });

  it("can be forced back to OpenAI without unsetting Azure", () => {
    // Rolling back should not require deleting configuration.
    const cfg = resolveAiConfig(env({ ...AZURE, AI_PROVIDER: "openai" }));
    expect(cfg.provider).toBe("openai");
  });

  it("strips a trailing slash from the endpoint", () => {
    // Azure's portal shows the endpoint with one; a double slash 404s.
    const cfg = resolveAiConfig(env(AZURE));
    expect(cfg.base).toBe("https://notemd-eu.services.ai.azure.com");
    expect(chatCompletionsUrl(cfg, "gpt-4o")).not.toContain("//openai");
  });
});

describe("URL construction", () => {
  const azure = resolveAiConfig(env(AZURE));
  const openai = resolveAiConfig(env({ OPENAI_API_KEY: "sk-test" }));

  it("addresses an Azure deployment in the path with an api-version", () => {
    expect(chatCompletionsUrl(azure, "gpt-4o")).toBe(
      "https://notemd-eu.services.ai.azure.com/openai/deployments/gpt-4o" +
        "/chat/completions?api-version=2024-10-21",
    );
  });

  it("uses the audio api-version for transcription, not the chat one", () => {
    // Azure's audio endpoints are on a different, preview api-version; using
    // the chat one returns a 404 that looks like a missing deployment.
    const url = transcriptionsUrl(azure, "gpt-4o-transcribe");
    expect(url).toContain("/audio/transcriptions");
    expect(url).toContain("api-version=2025-03-01-preview");
    expect(url).not.toContain("api-version=2024-10-21");
  });

  it("leaves the OpenAI paths unchanged", () => {
    expect(chatCompletionsUrl(openai, "gpt-4o")).toBe("https://api.openai.com/v1/chat/completions");
    expect(transcriptionsUrl(openai, "gpt-4o-transcribe")).toBe(
      "https://api.openai.com/v1/audio/transcriptions",
    );
  });

  it("escapes a deployment name so it cannot alter the path", () => {
    expect(chatCompletionsUrl(azure, "a/b")).toContain("/deployments/a%2Fb/");
  });
});

describe("authentication", () => {
  it("sends api-key to Azure and never a bearer token", () => {
    const h = authHeaders(resolveAiConfig(env(AZURE)));
    expect(h["api-key"]).toBe("azure-key");
    expect(h.Authorization).toBeUndefined();
  });

  it("sends a bearer token to OpenAI and never api-key", () => {
    const h = authHeaders(resolveAiConfig(env({ OPENAI_API_KEY: "sk-test" })));
    expect(h.Authorization).toBe("Bearer sk-test");
    expect(h["api-key"]).toBeUndefined();
  });
});

describe("model and deployment naming", () => {
  it("defaults to the agreed deployment names on Azure", () => {
    const cfg = resolveAiConfig(env(AZURE));
    expect(cfg.letterModel).toBe("gpt-4o");
    expect(cfg.fastModel).toBe("gpt-4o-mini");
    expect(cfg.transcribeModel).toBe("gpt-4o-transcribe");
  });

  it("lets each deployment be renamed independently", () => {
    // A deployment name is chosen by whoever created it and need not match
    // the underlying model.
    const cfg = resolveAiConfig(
      env({ ...AZURE, AZURE_OPENAI_TRANSCRIBE_DEPLOYMENT: "gpt-transcribe" }),
    );
    expect(cfg.transcribeModel).toBe("gpt-transcribe");
    expect(cfg.letterModel).toBe("gpt-4o");
  });
});

describe("residency evidence", () => {
  it("reads the processing region from the response headers", () => {
    // Turns the residency claim into an observation rather than a setting.
    const headers = new Headers({ "x-ms-region": "France Central" });
    expect(processingRegion(headers)).toBe("France Central");
    expect(processingRegion(new Headers())).toBeNull();
  });
});

describe("every call site routes through the module", () => {
  const ROOT = join(__dirname, "../..");
  const FUNCTIONS = join(ROOT, "supabase/functions");
  const sources = readdirSync(FUNCTIONS, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({
      name: e.name,
      body: (() => {
        try {
          return readFileSync(join(FUNCTIONS, e.name, "index.ts"), "utf8");
        } catch {
          return "";
        }
      })(),
    }));

  it("hard-codes no api.openai.com URL", () => {
    // A single missed call site would keep sending clinical content to the
    // old provider after the migration, silently.
    const offenders = sources
      .filter(({ body }) => /["'`]https:\/\/api\.openai\.com/.test(body))
      .map(({ name }) => name);
    expect(offenders).toEqual([]);
  });

  it("builds no bearer header for the AI provider by hand", () => {
    const offenders = sources
      .filter(({ body }) => /Authorization: `Bearer \$\{(OPENAI_API_KEY|aiConfig)/.test(body))
      .map(({ name }) => name);
    expect(offenders).toEqual([]);
  });

  it("routes all three AI functions through it", () => {
    for (const name of ["generate-letter", "regenerate-letter", "transcribe-audio"]) {
      const src = sources.find((s) => s.name === name)!.body;
      expect(src, `${name} does not import the provider module`).toMatch(
        /from "\.\.\/_shared\/ai-provider\.ts"/,
      );
      expect(src, `${name} does not resolve a config`).toMatch(/resolveAiConfig/);
    }
  });
});
