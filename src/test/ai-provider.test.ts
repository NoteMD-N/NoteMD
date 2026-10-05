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
  isPlausibleAzureEndpoint,
  isPlausibleAzureKey,
  classifyProviderStatus,
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
  // Shaped like a real key, not "azure-key": a key too short to be genuine is
  // treated as an unsubstituted placeholder and ignored, which is the point of
  // isPlausibleAzureKey below.
  AZURE_OPENAI_API_KEY: "0123456789abcdef0123456789abcdef",
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
    expect(h["api-key"]).toBe(AZURE.AZURE_OPENAI_API_KEY);
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
    expect(cfg.transcribeModel).toBe("gpt-4o-transcribe");
  });

  it("reuses the letter deployment for quick refinements unless told otherwise", () => {
    // The client's resource has no gpt-4o-mini deployment; refinement must not
    // depend on one existing.
    expect(resolveAiConfig(env(AZURE)).fastModel).toBe("gpt-4o");
    expect(
      resolveAiConfig(env({ ...AZURE, AZURE_OPENAI_LETTER_DEPLOYMENT: "letters" })).fastModel,
    ).toBe("letters");
    expect(
      resolveAiConfig(env({ ...AZURE, AZURE_OPENAI_FAST_DEPLOYMENT: "gpt-4o-mini" })).fastModel,
    ).toBe("gpt-4o-mini");
  });

  it("leaves the OpenAI refinement model unchanged", () => {
    // Production is on OpenAI today; this change must not alter its behaviour.
    expect(resolveAiConfig(env({ OPENAI_API_KEY: "sk-test" })).fastModel).toBe("gpt-4o-mini");
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

/**
 * A literal placeholder stored as a secret.
 *
 * `supabase secrets set AZURE_OPENAI_API_KEY='<the key>'` run verbatim out of
 * a command example puts the angle brackets in the secret. The value is
 * non-empty, so every truthy test calls it configured, and the system switches
 * to a provider that rejects every request — taking down dictation and letter
 * generation rather than degrading. It has happened in production on this
 * project, on the email path and then on this one.
 */
describe("refusing to treat a placeholder as configuration", () => {
  const AZURE = "https://notemd-eu.openai.azure.com";
  const REAL_KEY = "a".repeat(84);

  const env = (vars: Record<string, string>) => (name: string) => vars[name];

  it("rejects the exact placeholder that caused the outage", () => {
    expect(isPlausibleAzureKey("<the notemd-eu key>")).toBe(false);
  });

  it("rejects placeholders and truncated pastes generally", () => {
    for (const bad of [
      "",
      "   ",
      "<key>",
      "<your-azure-key>",
      "your-api-key-here",
      "changeme",
      "abc123",                    // too short to be a key
      "a".repeat(31),              // one short of the floor
      "a".repeat(40) + " " + "b".repeat(40), // two tokens: a bad paste
    ]) {
      expect(isPlausibleAzureKey(bad), `accepted ${JSON.stringify(bad)}`).toBe(false);
    }
  });

  it("accepts the key shapes Azure actually issues", () => {
    expect(isPlausibleAzureKey("0123456789abcdef0123456789abcdef")).toBe(true); // 32 hex
    expect(isPlausibleAzureKey(REAL_KEY)).toBe(true);
    // Surrounding whitespace from a paste is trimmed rather than treated as a
    // broken value; only whitespace *inside* the key means a bad paste.
    expect(isPlausibleAzureKey(`  ${REAL_KEY}  `)).toBe(true);
    expect(isPlausibleAzureKey(`${REAL_KEY}\n`)).toBe(true);
  });

  it("rejects a placeholder endpoint", () => {
    expect(isPlausibleAzureEndpoint("<endpoint>")).toBe(false);
    expect(isPlausibleAzureEndpoint("notemd-eu.openai.azure.com")).toBe(false); // no scheme
    expect(isPlausibleAzureEndpoint("http://notemd-eu.openai.azure.com")).toBe(false); // not https
    expect(isPlausibleAzureEndpoint(AZURE)).toBe(true);
  });

  it("serves traffic on OpenAI rather than on a provider that would reject it", () => {
    const config = resolveAiConfig(
      env({ AZURE_OPENAI_ENDPOINT: AZURE, AZURE_OPENAI_API_KEY: "<the notemd-eu key>", OPENAI_API_KEY: "sk-real" }),
    );
    expect(config.provider).toBe("openai");
    expect(config.apiKey).toBe("sk-real");
  });

  it("still switches to Azure when the key is real", () => {
    const config = resolveAiConfig(
      env({ AZURE_OPENAI_ENDPOINT: AZURE, AZURE_OPENAI_API_KEY: REAL_KEY }),
    );
    expect(config.provider).toBe("azure");
    expect(config.base).toBe(AZURE);
  });

  it("does not let an explicit force insist on a broken provider", () => {
    // Forcing is for choosing between two working configurations, not for
    // demanding one that rejects every clinical request.
    const config = resolveAiConfig(
      env({ AI_PROVIDER: "azure", AZURE_OPENAI_ENDPOINT: AZURE, AZURE_OPENAI_API_KEY: "<key>" }),
    );
    expect(config.provider).toBe("openai");
  });

  it("does not fall back silently", () => {
    // A silent fallback is how the wrong provider serves clinical traffic for
    // a week before anyone reads a bill or a residency log.
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.join(" ")); };
    try {
      resolveAiConfig(env({ AZURE_OPENAI_ENDPOINT: AZURE, AZURE_OPENAI_API_KEY: "<key>" }));
    } finally {
      console.error = original;
    }
    expect(errors.join(" ")).toMatch(/placeholder/i);
  });

  it("says nothing when Azure was simply never configured", () => {
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.join(" ")); };
    try {
      resolveAiConfig(env({ OPENAI_API_KEY: "sk-real" }));
    } finally {
      console.error = original;
    }
    expect(errors).toEqual([]);
  });

  it("treats an endpoint on its own as not configured, as before", () => {
    // The pre-existing guarantee: a part-done migration must not take letter
    // generation down.
    expect(resolveAiConfig(env({ AZURE_OPENAI_ENDPOINT: AZURE })).provider).toBe("openai");
  });
});

describe("what a probe status proves about the credential", () => {
  it("treats a transcription as acceptance", () => {
    expect(classifyProviderStatus(200)).toBe(true);
  });

  it("treats a complaint about the audio as acceptance", () => {
    // The probe sends a one-second tone. A provider that authenticates and
    // then rejects the audio has proved the credential, which is what is
    // being tested.
    expect(classifyProviderStatus(400)).toBe(true);
  });

  it("treats a missing deployment as a failure, not as inconclusive", () => {
    // On Azure a 404 means the deployment name does not exist on the
    // resource. Every dictation request would fail. Calling that
    // "unverified" would let a broken switch pass the one check whose job
    // is to catch it.
    expect(classifyProviderStatus(404)).toBe(false);
  });

  it("treats a rejected credential as a failure", () => {
    expect(classifyProviderStatus(401)).toBe(false);
    expect(classifyProviderStatus(403)).toBe(false);
  });

  it("does not claim a verdict from a status that gives none", () => {
    // A rate limit or a provider-side fault says nothing about the key, and
    // reporting either as working or broken would be a guess.
    for (const status of [429, 500, 502, 503]) {
      expect(classifyProviderStatus(status), `status ${status}`).toBeNull();
    }
  });
});
