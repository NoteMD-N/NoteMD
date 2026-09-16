import {
  APP_ENVIRONMENT,
  ENVIRONMENT_LABELS,
  IS_PRODUCTION,
  SUPABASE_URL,
  isPointedAtProductionData,
  supabaseProjectRef,
} from "@/lib/environment";

/**
 * Marks any build that is not production.
 *
 * Staging is only useful if nobody mistakes it for production, and the mistake
 * is easy to make: the two are the same application, and the difference is one
 * environment variable. Synthetic patient data looks like real patient data.
 *
 * Renders nothing in production, so it costs live users nothing.
 */
export const EnvironmentBanner = () => {
  if (IS_PRODUCTION) return null;

  const misconfigured = isPointedAtProductionData();
  const ref = supabaseProjectRef(SUPABASE_URL) ?? "unknown project";

  // A non-production build talking to the production database is the failure
  // this whole separation exists to prevent, and it is silent: everything
  // works, and the records are real. It gets its own treatment.
  if (misconfigured) {
    return (
      <div
        role="alert"
        style={{
          position: "sticky",
          top: 0,
          zIndex: 100,
          background: "#b4151b",
          color: "#ffffff",
          padding: "10px 16px",
          fontSize: 13,
          fontWeight: 700,
          letterSpacing: "0.02em",
          textAlign: "center",
        }}
      >
        {ENVIRONMENT_LABELS[APP_ENVIRONMENT]} build is connected to the PRODUCTION
        database ({ref}). Stop and correct the configuration before continuing —
        this session is reading and writing real patient records.
      </div>
    );
  }

  return (
    <div
      style={{
        position: "sticky",
        top: 0,
        zIndex: 100,
        background: APP_ENVIRONMENT === "staging" ? "#8a5a00" : "#3c4a5a",
        color: "#ffffff",
        padding: "6px 16px",
        fontSize: 12,
        fontWeight: 600,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        textAlign: "center",
      }}
    >
      {ENVIRONMENT_LABELS[APP_ENVIRONMENT]} · synthetic data only · {ref}
    </div>
  );
};

export default EnvironmentBanner;
