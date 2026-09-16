/**
 * Which deployment this build is talking to.
 *
 * Staging exists so that routine development and testing stop happening
 * against the production clinical database. That only holds if it is
 * impossible to be unsure which one you are looking at, so the environment is
 * declared explicitly per build rather than guessed, and anything that is not
 * production says so on screen.
 *
 * Vite resolves these at build time from the mode-specific env file:
 *
 *   npm run dev              -> .env.development  -> local    (staging data)
 *   npm run build:staging    -> .env.staging      -> staging  (synthetic data)
 *   npm run build            -> .env.production   -> production
 */

export type AppEnvironment = "production" | "staging" | "local";

const RAW = (import.meta.env.VITE_APP_ENV ?? "").trim().toLowerCase();

/**
 * Unrecognised values resolve to "local", not "production".
 *
 * A misconfigured build that silently claimed to be production would hide the
 * banner and disable the safety checks below — exactly the wrong way to fail.
 * Treating the unknown case as local is loud and harmless.
 */
export const APP_ENVIRONMENT: AppEnvironment =
  RAW === "production" ? "production" : RAW === "staging" ? "staging" : "local";

export const IS_PRODUCTION = APP_ENVIRONMENT === "production";

/** The Supabase project this build points at, for display and for the guard. */
export const SUPABASE_URL: string = import.meta.env.VITE_SUPABASE_URL ?? "";

/** Project ref, e.g. "mdunhinhsrdrilxcdbvq" from https://<ref>.supabase.co */
export function supabaseProjectRef(url: string = SUPABASE_URL): string | null {
  const match = url.match(/^https:\/\/([a-z0-9]+)\.supabase\./i);
  return match ? match[1] : null;
}

/**
 * The production project ref, recorded so a non-production build can detect
 * that it has been pointed at live patient data.
 *
 * This is not a secret — it is the subdomain of a public API endpoint, and it
 * is already in the production bundle.
 */
export const PRODUCTION_PROJECT_REF = "mdunhinhsrdrilxcdbvq";

/**
 * True when a build that is not production is nonetheless talking to the
 * production database. This is the mistake the staging environment exists to
 * prevent, and the one most likely to go unnoticed: everything works, and the
 * data is real.
 */
export function isPointedAtProductionData(
  env: AppEnvironment = APP_ENVIRONMENT,
  url: string = SUPABASE_URL,
): boolean {
  return env !== "production" && supabaseProjectRef(url) === PRODUCTION_PROJECT_REF;
}

export const ENVIRONMENT_LABELS: Record<AppEnvironment, string> = {
  production: "Production",
  staging: "Staging",
  local: "Local development",
};
