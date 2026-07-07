import { useAuth } from "@/hooks/useAuth";
import { Link } from "react-router-dom";

/**
 * Ported from the imported Claude Design "NoteMD Landing Page" file.
 * Inline styles mirror the source file exactly so the visual output stays
 * pixel-close to the design. Two things differ intentionally:
 *   - CTAs route to /auth (or /dashboard when signed in) instead of #contact
 *   - Hero and "practice" imagery are rendered as on-brand SVG mockups since
 *     the design left the photo slots as placeholders.
 */

// ---------- Small SVG helpers ----------
const Check = () => (
  <svg width={18} height={18} viewBox="0 0 24 24" fill="none" style={{ display: "block" }}>
    <path
      d="M20 6L9 17l-5-5"
      stroke="currentColor"
      strokeWidth={2.4}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const iconProps = {
  width: 24,
  height: 24,
  viewBox: "0 0 24 24",
  fill: "none",
} as const;
const P = (d: string) => (
  <path d={d} stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" fill="none" />
);

const IconBolt = () => <svg {...iconProps}>{P("M13 2L4.5 13.5H11l-1 8.5L19.5 10H13z")}</svg>;
const IconLayers = () => (
  <svg {...iconProps}>
    {P("M12 3l9 5-9 5-9-5 9-5z")}
    {P("M3 13l9 5 9-5")}
  </svg>
);
const IconClock = () => (
  <svg {...iconProps}>
    <circle cx={12} cy={12} r={9} stroke="currentColor" strokeWidth={2} fill="none" />
    {P("M12 7v5l3 2")}
  </svg>
);
const IconChat = () => (
  <svg {...iconProps}>{P("M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.7A8.5 8.5 0 1 1 21 11.5z")}</svg>
);
const IconMail = () => (
  <svg {...iconProps}>
    <rect x={3} y={5} width={18} height={14} rx={2} stroke="currentColor" strokeWidth={2} fill="none" />
    {P("M3 7l9 6 9-6")}
  </svg>
);
const IconPhone = () => (
  <svg {...iconProps}>
    {P(
      "M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3.1-8.7A2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"
    )}
  </svg>
);
const IconWeb = () => (
  <svg {...iconProps}>
    <circle cx={12} cy={12} r={9} stroke="currentColor" strokeWidth={2} fill="none" />
    {P("M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18")}
  </svg>
);
const IconArrow = () => (
  <svg width={20} height={20} viewBox="0 0 24 24" fill="none">
    {P("M5 12h14M13 6l6 6-6 6")}
  </svg>
);
const PulseLine = () => (
  <svg width={280} height={28} viewBox="0 0 280 28" fill="none" style={{ display: "block", opacity: 0.5 }}>
    <path
      d="M0 14 H96 l8 -11 l9 22 l7 -16 l6 8 H280"
      stroke="#10a294"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

// ---------- Hero mockup: a stylised structured-letter preview ----------
const HeroMockup = () => (
  <div
    style={{
      position: "relative",
      zIndex: 1,
      width: "100%",
      height: 460,
      borderRadius: 18,
      background: "linear-gradient(155deg, #ffffff 0%, #f3f8fb 100%)",
      boxShadow: "0 30px 70px -28px rgba(12,37,69,0.42)",
      border: "1px solid #e6edf3",
      overflow: "hidden",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: 28,
    }}
  >
    <div
      style={{
        width: "100%",
        maxWidth: 460,
        background: "#ffffff",
        borderRadius: 12,
        boxShadow: "0 12px 32px -12px rgba(12,37,69,0.18)",
        border: "1px solid #eef3f7",
        padding: 22,
        fontFamily: "'Source Sans 3', sans-serif",
        fontSize: 13.5,
        lineHeight: 1.55,
        color: "#2a3d52",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: "0.07em",
              textTransform: "uppercase",
              color: "#ffffff",
              background: "#10a294",
              padding: "4px 10px",
              borderRadius: 5,
            }}
          >
            Structured letter
          </span>
          <span style={{ fontSize: 12, color: "#6b7c90" }}>Draft ready</span>
        </div>
        <span style={{ fontSize: 12, color: "#9aa7b5" }}>0:47</span>
      </div>
      <div style={{ fontWeight: 700, color: "#0c2545" }}>Re: Mr J. Smith</div>
      <div style={{ color: "#54667a", fontSize: 12, marginBottom: 14 }}>DOB 14/05/1966 · Date: 24 May 2026</div>
      <div style={{ fontFamily: "'Libre Franklin', sans-serif", fontWeight: 700, fontSize: 11.5, letterSpacing: "0.02em", color: "#0c7d72", marginBottom: 3 }}>HISTORY</div>
      <p style={{ margin: "0 0 12px" }}>Unilateral right-sided headaches with associated nausea, preceded by visual aura. Occur 1–2 times weekly, lasting several hours.</p>
      <div style={{ fontFamily: "'Libre Franklin', sans-serif", fontWeight: 700, fontSize: 11.5, letterSpacing: "0.02em", color: "#0c7d72", marginBottom: 3 }}>ASSESSMENT</div>
      <p style={{ margin: "0 0 12px" }}>Migraine with aura.</p>
      <div style={{ fontFamily: "'Libre Franklin', sans-serif", fontWeight: 700, fontSize: 11.5, letterSpacing: "0.02em", color: "#0c7d72", marginBottom: 3 }}>PLAN</div>
      <ul style={{ margin: 0, paddingLeft: 16 }}>
        <li>Continue sumatriptan 50mg PRN</li>
        <li>Consider prophylaxis if frequency increases</li>
        <li>Review in 3 months</li>
      </ul>
    </div>
  </div>
);

// ---------- Practice illustration: stylised clinic scene ----------
const PracticeIllustration = () => (
  <div
    style={{
      display: "block",
      width: "100%",
      height: 440,
      borderRadius: 18,
      background: "linear-gradient(160deg, #e9f4f2 0%, #f3f8fb 100%)",
      boxShadow: "0 24px 60px -30px rgba(12,37,69,0.38)",
      border: "1px solid #e6edf3",
      position: "relative",
      overflow: "hidden",
    }}
  >
    <svg viewBox="0 0 560 440" width="100%" height="100%" preserveAspectRatio="xMidYMid slice" style={{ display: "block" }}>
      {/* soft blobs */}
      <circle cx={80} cy={70} r={90} fill="#cfeae5" opacity={0.6} />
      <circle cx={490} cy={370} r={110} fill="#dceaef" opacity={0.6} />
      {/* device / clinical dashboard silhouette */}
      <rect x={110} y={110} width={340} height={220} rx={18} fill="#ffffff" stroke="#e6edf3" strokeWidth={1.5} />
      <rect x={110} y={110} width={340} height={40} rx={18} fill="#0c2545" />
      <circle cx={130} cy={130} r={5} fill="#4fd6c5" />
      <circle cx={148} cy={130} r={5} fill="#ffffff" opacity={0.3} />
      <circle cx={166} cy={130} r={5} fill="#ffffff" opacity={0.3} />
      {/* content lines */}
      <rect x={130} y={170} width={110} height={12} rx={4} fill="#0c7d72" />
      <rect x={130} y={192} width={280} height={8} rx={3} fill="#dbe4ec" />
      <rect x={130} y={208} width={260} height={8} rx={3} fill="#dbe4ec" />
      <rect x={130} y={224} width={210} height={8} rx={3} fill="#dbe4ec" />
      <rect x={130} y={252} width={80} height={12} rx={4} fill="#0c7d72" />
      <rect x={130} y={274} width={290} height={8} rx={3} fill="#dbe4ec" />
      <rect x={130} y={290} width={240} height={8} rx={3} fill="#dbe4ec" />
      {/* record button */}
      <circle cx={280} cy={370} r={34} fill="#10a294" />
      <circle cx={280} cy={370} r={44} fill="none" stroke="#10a294" strokeOpacity={0.25} strokeWidth={2} />
      <rect x={272} y={360} width={16} height={20} rx={5} fill="#ffffff" />
      {/* pulse */}
      <path d="M60 210 H190 l14 -22 l16 44 l12 -32 l10 16 H420" stroke="#10a294" strokeWidth={2.5} fill="none" strokeLinecap="round" strokeLinejoin="round" opacity={0.55} />
    </svg>
  </div>
);

// ---------- Layout helpers ----------
const Section: React.FC<React.PropsWithChildren<React.HTMLAttributes<HTMLElement>>> = ({ children, style, ...rest }) => (
  <section style={style} {...rest}>
    {children}
  </section>
);

const Container: React.FC<React.PropsWithChildren<{ maxWidth?: number; style?: React.CSSProperties }>> = ({
  children,
  maxWidth = 1180,
  style,
}) => (
  <div style={{ maxWidth, margin: "0 auto", padding: "0 32px", ...style }}>{children}</div>
);

// ---------- Page ----------
const Landing = () => {
  const { user } = useAuth();
  const primaryHref = user ? "/dashboard" : "/auth";
  const primaryLabel = user ? "Go to dashboard" : "Get started today";
  const secondaryLabel = user ? "Open dashboard" : "Sign in";

  const linkReset: React.CSSProperties = { textDecoration: "none" };

  return (
    <div style={{ background: "#ffffff", color: "#0c2545", fontFamily: "'Source Sans 3', -apple-system, BlinkMacSystemFont, sans-serif" }}>
      {/* Header */}
      <header
        style={{
          position: "sticky",
          top: 0,
          zIndex: 50,
          background: "rgba(255,255,255,0.88)",
          backdropFilter: "saturate(180%) blur(12px)",
          borderBottom: "1px solid #e6edf3",
        }}
      >
        <Container style={{ padding: "14px 32px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 24 }}>
          <Link to="/" style={{ ...linkReset, display: "flex", alignItems: "center", flexShrink: 0 }}>
            <img src="/notemdcolor.png" alt="NoteMD" style={{ height: 38, width: "auto", display: "block" }} />
          </Link>
          <nav style={{ display: "flex", alignItems: "center", gap: 34 }} className="landing-nav">
            <a href="#demo" style={{ fontSize: 15, fontWeight: 600, color: "#44566b", ...linkReset }}>Demo</a>
            <a href="#how" style={{ fontSize: 15, fontWeight: 600, color: "#44566b", ...linkReset }}>How it works</a>
            <a href="#specialties" style={{ fontSize: 15, fontWeight: 600, color: "#44566b", ...linkReset }}>Specialties</a>
            <a href="#security" style={{ fontSize: 15, fontWeight: 600, color: "#44566b", ...linkReset }}>Security</a>
            <a href="#pricing" style={{ fontSize: 15, fontWeight: 600, color: "#44566b", ...linkReset }}>Pricing</a>
            <Link
              to={primaryHref}
              style={{
                fontSize: 15,
                fontWeight: 700,
                color: "#ffffff",
                background: "#14315c",
                padding: "11px 22px",
                borderRadius: 8,
                letterSpacing: "0.01em",
                ...linkReset,
              }}
            >
              {user ? "Dashboard" : "Get started"}
            </Link>
          </nav>
        </Container>
      </header>

      <main id="top">
        {/* HERO */}
        <Section style={{ position: "relative", overflow: "hidden", background: "linear-gradient(180deg, #f3f8fb 0%, #ffffff 100%)" }}>
          <Container
            style={{
              padding: "84px 32px 92px",
              display: "grid",
              gridTemplateColumns: "1.05fr 0.95fr",
              gap: 64,
              alignItems: "center",
            }}
          >
            <div>
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 9,
                  padding: "7px 14px",
                  background: "#e3f4f1",
                  borderRadius: 100,
                  marginBottom: 26,
                }}
              >
                <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#10a294", display: "inline-block" }} />
                <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "#0c7d72" }}>
                  Built by clinicians, for clinicians
                </span>
              </div>
              <h1
                style={{
                  fontFamily: "'Libre Franklin', sans-serif",
                  fontWeight: 800,
                  fontSize: "clamp(40px, 5vw, 60px)",
                  lineHeight: 1.04,
                  letterSpacing: "-0.025em",
                  margin: "0 0 22px",
                  color: "#0c2545",
                }}
              >
                AI-powered clinical
                <br />
                documentation
              </h1>
              <p style={{ fontSize: 19, lineHeight: 1.6, color: "#44566b", margin: "0 0 34px", maxWidth: 520 }}>
                NoteMD turns dictated or written input into accurate, structured clinical notes in seconds — so you spend less time on paperwork and more time with patients.
              </p>
              <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
                <Link
                  to={primaryHref}
                  style={{ fontSize: 17, fontWeight: 700, color: "#ffffff", background: "#14315c", padding: "15px 30px", borderRadius: 9, ...linkReset }}
                >
                  {primaryLabel}
                </Link>
                <a
                  href="#how"
                  style={{
                    fontSize: 17,
                    fontWeight: 700,
                    color: "#14315c",
                    background: "#ffffff",
                    border: "1.5px solid #cdd9e3",
                    padding: "14px 28px",
                    borderRadius: 9,
                    ...linkReset,
                  }}
                >
                  See how it works
                </a>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 22, marginTop: 34, flexWrap: "wrap" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ color: "#10a294" }}><Check /></span>
                  <span style={{ fontSize: 14.5, fontWeight: 600, color: "#54667a" }}>GDPR compliant</span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ color: "#10a294" }}><Check /></span>
                  <span style={{ fontSize: 14.5, fontWeight: 600, color: "#54667a" }}>NHS-ready</span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ color: "#10a294" }}><Check /></span>
                  <span style={{ fontSize: 14.5, fontWeight: 600, color: "#54667a" }}>Patient-data protected</span>
                </div>
              </div>
            </div>
            <div style={{ position: "relative" }}>
              <div
                style={{
                  position: "absolute",
                  inset: -18,
                  background: "radial-gradient(120% 120% at 70% 20%, rgba(16,162,148,0.14), transparent 60%)",
                  borderRadius: 28,
                  zIndex: 0,
                }}
              />
              <HeroMockup />
            </div>
          </Container>
        </Section>

        {/* TRUST / STAT STRIP */}
        <Section style={{ borderTop: "1px solid #eef3f7", borderBottom: "1px solid #eef3f7", background: "#ffffff" }}>
          <Container style={{ padding: "36px 32px", display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 32 }}>
            <div style={{ textAlign: "center" }}>
              <div style={{ fontFamily: "'Libre Franklin', sans-serif", fontWeight: 800, fontSize: 34, color: "#14315c", letterSpacing: "-0.02em" }}>Seconds</div>
              <div style={{ fontSize: 15, color: "#5b6b80", marginTop: 4 }}>to a structured clinical note</div>
            </div>
            <div style={{ textAlign: "center", borderLeft: "1px solid #eef3f7", borderRight: "1px solid #eef3f7" }}>
              <div style={{ fontFamily: "'Libre Franklin', sans-serif", fontWeight: 800, fontSize: 34, color: "#14315c", letterSpacing: "-0.02em" }}>Less admin</div>
              <div style={{ fontSize: 15, color: "#5b6b80", marginTop: 4 }}>more time for patient care</div>
            </div>
            <div style={{ textAlign: "center" }}>
              <div style={{ fontFamily: "'Libre Franklin', sans-serif", fontWeight: 800, fontSize: 34, color: "#14315c", letterSpacing: "-0.02em" }}>GDPR &amp; NHS</div>
              <div style={{ fontSize: 15, color: "#5b6b80", marginTop: 4 }}>compliant by design</div>
            </div>
          </Container>
        </Section>

        {/* SEE THE DIFFERENCE */}
        <Section id="demo" style={{ padding: "100px 0", background: "#f3f8fb" }}>
          <Container>
            <div style={{ maxWidth: 720, margin: "0 auto 52px", textAlign: "center" }}>
              <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "#0c7d72", marginBottom: 16 }}>
                See the difference
              </div>
              <h2 style={{ fontFamily: "'Libre Franklin', sans-serif", fontWeight: 800, fontSize: "clamp(30px, 3.6vw, 42px)", lineHeight: 1.1, letterSpacing: "-0.02em", margin: "0 0 16px", color: "#0c2545" }}>
                From raw consultation to consultant letter
              </h2>
              <p style={{ fontSize: 18, color: "#44566b", margin: 0 }}>
                The same encounter — dictated in seconds, returned as a structured, professional clinical letter.
              </p>
            </div>
            <div className="landing-demo-grid" style={{ display: "grid", gridTemplateColumns: "1fr 56px 1fr", gap: 0, alignItems: "stretch" }}>
              {/* BEFORE */}
              <div style={{ background: "#ffffff", border: "1px solid #e6edf3", borderRadius: 16, overflow: "hidden", boxShadow: "0 18px 44px -30px rgba(12,37,69,0.3)" }}>
                <div style={{ padding: "14px 22px", borderBottom: "1px solid #eef3f7", display: "flex", alignItems: "center", gap: 10, background: "#f6f8fa" }}>
                  <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.07em", textTransform: "uppercase", color: "#6b7c90", background: "#e7edf3", padding: "4px 10px", borderRadius: 5 }}>Before</span>
                  <span style={{ fontSize: 14, fontWeight: 600, color: "#54667a" }}>Raw consultation transcript</span>
                </div>
                <div style={{ padding: "26px 24px", fontFamily: "'Source Sans 3', sans-serif", fontSize: 14.5, lineHeight: 1.75, color: "#5b6b80" }}>
                  <p style={{ margin: "0 0 9px" }}><strong style={{ color: "#44566b" }}>Doctor:</strong> Morning, what's brought you in today?</p>
                  <p style={{ margin: "0 0 9px" }}><strong style={{ color: "#44566b" }}>Patient:</strong> These headaches keep coming back — right side, really painful.</p>
                  <p style={{ margin: "0 0 9px" }}><strong style={{ color: "#44566b" }}>Doctor:</strong> How often, and how long do they last?</p>
                  <p style={{ margin: "0 0 9px" }}><strong style={{ color: "#44566b" }}>Patient:</strong> Once or twice a week, a few hours. I feel a bit sick with them.</p>
                  <p style={{ margin: "0 0 9px" }}><strong style={{ color: "#44566b" }}>Doctor:</strong> Any visual changes beforehand?</p>
                  <p style={{ margin: "0 0 9px" }}><strong style={{ color: "#44566b" }}>Patient:</strong> Yeah — flashing lights sometimes before it starts.</p>
                  <p style={{ margin: "0 0 9px" }}><strong style={{ color: "#44566b" }}>Doctor:</strong> And any medication for them?</p>
                  <p style={{ margin: "0 0 9px" }}><strong style={{ color: "#44566b" }}>Patient:</strong> Just sumatriptan when they hit.</p>
                  <p style={{ margin: 0, color: "#9aa7b5" }}>Doctor: Okay, let's examine you…</p>
                </div>
              </div>
              {/* ARROW */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
                <div style={{ width: 44, height: 44, borderRadius: "50%", background: "#10a294", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 10px 24px -8px rgba(16,162,148,0.6)" }}>
                  <IconArrow />
                </div>
              </div>
              {/* AFTER */}
              <div style={{ background: "#ffffff", border: "1.5px solid #cfeae5", borderRadius: 16, overflow: "hidden", boxShadow: "0 22px 50px -28px rgba(12,37,69,0.4)" }}>
                <div style={{ padding: "14px 22px", borderBottom: "1px solid #e3f4f1", display: "flex", alignItems: "center", gap: 10, background: "#ecf8f6" }}>
                  <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.07em", textTransform: "uppercase", color: "#ffffff", background: "#10a294", padding: "4px 10px", borderRadius: 5 }}>After</span>
                  <span style={{ fontSize: 14, fontWeight: 600, color: "#0c7d72" }}>Structured clinical letter</span>
                </div>
                <div style={{ padding: 26, fontSize: 14.5, lineHeight: 1.6, color: "#2a3d52" }}>
                  <div style={{ fontWeight: 700, color: "#0c2545" }}>Re: Mr J. Smith</div>
                  <div style={{ color: "#54667a", fontSize: 13.5, marginBottom: 16 }}>DOB 14/05/1966 · Date: 24 May 2026</div>
                  <div style={{ fontFamily: "'Libre Franklin', sans-serif", fontWeight: 700, fontSize: 13, letterSpacing: "0.02em", color: "#0c7d72", marginBottom: 4 }}>HISTORY</div>
                  <p style={{ margin: "0 0 14px" }}>Unilateral right-sided headaches with associated nausea, preceded by visual aura. Occur 1–2 times weekly, lasting several hours.</p>
                  <div style={{ fontFamily: "'Libre Franklin', sans-serif", fontWeight: 700, fontSize: 13, letterSpacing: "0.02em", color: "#0c7d72", marginBottom: 4 }}>EXAMINATION</div>
                  <p style={{ margin: "0 0 14px" }}>Neurological examination unremarkable.</p>
                  <div style={{ fontFamily: "'Libre Franklin', sans-serif", fontWeight: 700, fontSize: 13, letterSpacing: "0.02em", color: "#0c7d72", marginBottom: 4 }}>ASSESSMENT</div>
                  <p style={{ margin: "0 0 14px" }}>Migraine with aura.</p>
                  <div style={{ fontFamily: "'Libre Franklin', sans-serif", fontWeight: 700, fontSize: 13, letterSpacing: "0.02em", color: "#0c7d72", marginBottom: 4 }}>PLAN</div>
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    <li>Continue sumatriptan 50mg PRN</li>
                    <li>Consider prophylaxis if frequency increases</li>
                    <li>Review in 3 months</li>
                  </ul>
                </div>
              </div>
            </div>
          </Container>
        </Section>

        {/* DESIGNED FOR REAL CLINICAL PRACTICE */}
        <Section id="practice" style={{ padding: "100px 0" }}>
          <Container style={{ display: "grid", gridTemplateColumns: "0.95fr 1.05fr", gap: 64, alignItems: "center" }}>
            <PracticeIllustration />
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "#0c7d72", marginBottom: 16 }}>
                Designed for real clinical practice
              </div>
              <h2 style={{ fontFamily: "'Libre Franklin', sans-serif", fontWeight: 800, fontSize: "clamp(30px, 3.6vw, 42px)", lineHeight: 1.1, letterSpacing: "-0.02em", margin: "0 0 20px", color: "#0c2545" }}>
                It fits the way you already work
              </h2>
              <p style={{ fontSize: 18, color: "#44566b", margin: "0 0 18px" }}>
                Developed by clinicians who understand the demands of healthcare, NoteMD integrates seamlessly into everyday practice.
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 26 }}>
                {[
                  ["Outpatient clinics", "letters and notes ready before the next patient."],
                  ["Inpatient care", "consistent, complete documentation on every round."],
                  ["Multidisciplinary teams", "clear communication across the care pathway."],
                ].map(([bold, rest]) => (
                  <div key={bold} style={{ display: "flex", gap: 13, alignItems: "flex-start" }}>
                    <span style={{ color: "#10a294", marginTop: 2 }}><Check /></span>
                    <span style={{ fontSize: 17, color: "#2a3d52" }}>
                      <strong style={{ color: "#0c2545" }}>{bold}</strong> — {rest}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </Container>
        </Section>

        {/* FASTER, CLEARER, SAFER */}
        <Section style={{ padding: "100px 0", background: "#f3f8fb" }}>
          <Container>
            <div style={{ maxWidth: 680, marginBottom: 56 }}>
              <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "#0c7d72", marginBottom: 16 }}>
                Faster, clearer, safer documentation
              </div>
              <h2 style={{ fontFamily: "'Libre Franklin', sans-serif", fontWeight: 800, fontSize: "clamp(30px, 3.6vw, 42px)", lineHeight: 1.1, letterSpacing: "-0.02em", margin: 0, color: "#0c2545" }}>
                Better documentation, less effort
              </h2>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 22 }} className="landing-feature-grid">
              {[
                { icon: <IconBolt />, title: "Notes in seconds", body: "Generate structured clinical letters and notes in seconds, not minutes." },
                { icon: <IconLayers />, title: "Clear and consistent", body: "Improve clarity, consistency, and completeness across every document." },
                { icon: <IconClock />, title: "Less admin burden", body: "Reduce time spent on repetitive administrative tasks and free up your day." },
                { icon: <IconChat />, title: "Stronger communication", body: "Support high-quality communication with GPs and the wider healthcare team." },
              ].map((f) => (
                <div key={f.title} style={{ background: "#ffffff", border: "1px solid #e6edf3", borderRadius: 16, padding: 34 }}>
                  <div style={{ width: 46, height: 46, borderRadius: 12, background: "#e3f4f1", display: "flex", alignItems: "center", justifyContent: "center", color: "#0c7d72", marginBottom: 20 }}>
                    {f.icon}
                  </div>
                  <h3 style={{ fontFamily: "'Libre Franklin', sans-serif", fontWeight: 700, fontSize: 21, margin: "0 0 9px", color: "#0c2545" }}>{f.title}</h3>
                  <p style={{ fontSize: 16.5, color: "#54667a", margin: 0 }}>{f.body}</p>
                </div>
              ))}
            </div>
          </Container>
        </Section>

        {/* HOW THE AI WORKS */}
        <Section id="how" style={{ padding: "100px 0" }}>
          <Container>
            <div style={{ maxWidth: 720, margin: "0 auto 56px", textAlign: "center" }}>
              <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "#0c7d72", marginBottom: 16 }}>
                AI that works the way clinicians think
              </div>
              <h2 style={{ fontFamily: "'Libre Franklin', sans-serif", fontWeight: 800, fontSize: "clamp(30px, 3.6vw, 42px)", lineHeight: 1.1, letterSpacing: "-0.02em", margin: "0 0 18px", color: "#0c2545" }}>
                You stay in control. The AI does the rest.
              </h2>
              <p style={{ fontSize: 18, color: "#44566b", margin: 0 }}>
                NoteMD transforms dictated or written input into well-organised clinical documentation — without losing clinical meaning or nuance.
              </p>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 0, alignItems: "stretch", position: "relative" }} className="landing-how-grid">
              {[
                { n: 1, color: "#14315c", title: "Capture", body: "Dictate or type as you normally would — in your own words, at your own pace.", divider: false },
                { n: 2, color: "#10a294", title: "Structure", body: "The AI handles formatting, structure, and efficiency — keeping every clinical detail intact.", divider: true },
                { n: 3, color: "#14315c", title: "Review & sign off", body: "You review the finished note, make any edits, and approve. The final word is always yours.", divider: false },
              ].map((step) => (
                <div
                  key={step.n}
                  style={{
                    padding: "0 30px",
                    textAlign: "center",
                    ...(step.divider ? { borderLeft: "1px solid #e6edf3", borderRight: "1px solid #e6edf3" } : {}),
                  }}
                >
                  <div style={{ width: 56, height: 56, borderRadius: "50%", background: step.color, color: "#fff", fontFamily: "'Libre Franklin', sans-serif", fontWeight: 800, fontSize: 22, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 20px" }}>
                    {step.n}
                  </div>
                  <h3 style={{ fontFamily: "'Libre Franklin', sans-serif", fontWeight: 700, fontSize: 20, margin: "0 0 9px", color: "#0c2545" }}>{step.title}</h3>
                  <p style={{ fontSize: 16, color: "#54667a", margin: 0 }}>{step.body}</p>
                </div>
              ))}
            </div>
            <div style={{ marginTop: 56, display: "flex", justifyContent: "center" }}><PulseLine /></div>
          </Container>
        </Section>

        {/* BUILT FOR SPECIALISTS */}
        <Section id="specialties" style={{ padding: "96px 0", background: "#f3f8fb" }}>
          <Container maxWidth={1020} style={{ textAlign: "center" }}>
            <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "#0c7d72", marginBottom: 16 }}>
              Built for specialists
            </div>
            <h2 style={{ fontFamily: "'Libre Franklin', sans-serif", fontWeight: 800, fontSize: "clamp(28px, 3.4vw, 40px)", lineHeight: 1.1, letterSpacing: "-0.02em", margin: "0 0 14px", color: "#0c2545" }}>
              Documentation for every specialty
            </h2>
            <p style={{ fontSize: 18, color: "#44566b", margin: "0 auto 40px", maxWidth: 620 }}>
              Designed to meet the needs of clinicians across a wide range of clinical settings.
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 13 }}>
              {["Neurology", "Cardiology", "General Medicine", "Respiratory Medicine", "Psychiatry", "Epilepsy", "Endocrinology", "Paediatrics", "+ many more"].map(
                (s) => (
                  <div key={s} style={{ display: "flex", alignItems: "center", gap: 9, background: "#ffffff", border: "1px solid #e0e9f0", borderRadius: 100, padding: "11px 22px" }}>
                    <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#10a294" }} />
                    <span style={{ fontSize: 16, fontWeight: 600, color: "#24384e" }}>{s}</span>
                  </div>
                )
              )}
            </div>
          </Container>
        </Section>

        {/* SECURITY / NHS-READY (dark) */}
        <Section id="security" style={{ padding: "100px 0", background: "#0c2545", color: "#ffffff" }}>
          <Container style={{ display: "grid", gridTemplateColumns: "0.9fr 1.1fr", gap: 64, alignItems: "center" }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "#4fd6c5", marginBottom: 16 }}>
                Simple, secure, and NHS-ready
              </div>
              <h2 style={{ fontFamily: "'Libre Franklin', sans-serif", fontWeight: 800, fontSize: "clamp(30px, 3.6vw, 42px)", lineHeight: 1.1, letterSpacing: "-0.02em", margin: "0 0 20px" }}>
                Patient-data protection at the core
              </h2>
              <p style={{ fontSize: 18, color: "#b9c8d6", margin: 0 }}>
                NoteMD is GDPR compliant and built with patient data protection as a core principle — engineered to meet the requirements of NHS clinical environments.
              </p>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
              {[
                "GDPR compliant with patient data protected by design",
                "Built to meet NHS clinical environment requirements",
                "Easy-to-use interface designed for busy clinicians",
                "Secure handling of clinical data across all use cases",
                "Works across multiple specialties and settings",
                "Flexible subscription model that scales with you",
              ].map((t) => (
                <div key={t} style={{ display: "flex", gap: 12, alignItems: "flex-start", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 13, padding: 20 }}>
                  <span style={{ color: "#4fd6c5", flexShrink: 0, marginTop: 1 }}><Check /></span>
                  <span style={{ fontSize: 15.5, color: "#e3ecf3", lineHeight: 1.45 }}>{t}</span>
                </div>
              ))}
            </div>
          </Container>
        </Section>

        {/* TESTIMONIALS */}
        <Section id="testimonials" style={{ padding: "100px 0", background: "#ffffff" }}>
          <Container>
            <div style={{ maxWidth: 680, margin: "0 auto 52px", textAlign: "center" }}>
              <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "#0c7d72", marginBottom: 16 }}>
                Trusted by clinicians
              </div>
              <h2 style={{ fontFamily: "'Libre Franklin', sans-serif", fontWeight: 800, fontSize: "clamp(30px, 3.6vw, 42px)", lineHeight: 1.1, letterSpacing: "-0.02em", margin: 0, color: "#0c2545" }}>
                What consultants are saying
              </h2>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 22 }} className="landing-testimonial-grid">
              {[
                {
                  quote: "Reduced my documentation time by over 70% and noticeably improved letter quality. A genuine game-changer for my clinic.",
                  initials: "SM",
                  bg: "#14315c",
                  name: "Dr Sarah Mitchell",
                  role: "Consultant Neurologist",
                },
                {
                  quote: "The letters are structured perfectly and capture all the important clinical detail. It has transformed my workflow.",
                  initials: "JO",
                  bg: "#10a294",
                  name: "Dr James O'Connor",
                  role: "Consultant Physician",
                },
                {
                  quote: "Excellent accuracy, easy to use and reassuringly secure. I wouldn't want to go back to working without it.",
                  initials: "PP",
                  bg: "#14315c",
                  name: "Dr Priya Patel",
                  role: "Consultant Psychiatrist",
                },
              ].map((t) => (
                <div key={t.name} style={{ background: "#ffffff", border: "1px solid #e6edf3", borderRadius: 16, padding: 32, display: "flex", flexDirection: "column" }}>
                  <div style={{ fontFamily: "'Libre Franklin', sans-serif", fontWeight: 800, fontSize: 40, lineHeight: 0.6, color: "#cfeae5" }}>“</div>
                  <p style={{ fontSize: 17, lineHeight: 1.55, color: "#2a3d52", margin: "10px 0 24px", flex: 1 }}>{t.quote}</p>
                  <div style={{ display: "flex", alignItems: "center", gap: 13 }}>
                    <span style={{ width: 44, height: 44, borderRadius: "50%", background: t.bg, color: "#fff", fontFamily: "'Libre Franklin', sans-serif", fontWeight: 700, fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center" }}>
                      {t.initials}
                    </span>
                    <div>
                      <div style={{ fontSize: 15.5, fontWeight: 700, color: "#0c2545" }}>{t.name}</div>
                      <div style={{ fontSize: 14, color: "#6b7c90" }}>{t.role}</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <p style={{ fontSize: 13.5, color: "#9aa7b5", textAlign: "center", margin: "28px 0 0" }}>Illustrative testimonials — replace with your own client quotes.</p>
          </Container>
        </Section>

        {/* BUILT FOR MODERN HEALTHCARE */}
        <Section style={{ padding: "96px 0" }}>
          <Container maxWidth={880} style={{ textAlign: "center" }}>
            <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "#0c7d72", marginBottom: 18 }}>
              Built for modern healthcare
            </div>
            <p style={{ fontFamily: "'Libre Franklin', sans-serif", fontWeight: 600, fontSize: "clamp(24px, 3vw, 34px)", lineHeight: 1.32, letterSpacing: "-0.015em", margin: 0, color: "#0c2545" }}>
              NoteMD is more than a documentation tool — it's a step toward <span style={{ color: "#0c7d72" }}>reducing burnout</span> and improving efficiency across healthcare systems by removing unnecessary administrative load.
            </p>
          </Container>
        </Section>

        {/* PRICING TEASER */}
        <Section id="pricing" style={{ padding: "100px 0", background: "#f3f8fb" }}>
          <Container>
            <div style={{ maxWidth: 680, margin: "0 auto 48px", textAlign: "center" }}>
              <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "#0c7d72", marginBottom: 16 }}>
                Simple, flexible pricing
              </div>
              <h2 style={{ fontFamily: "'Libre Franklin', sans-serif", fontWeight: 800, fontSize: "clamp(30px, 3.6vw, 42px)", lineHeight: 1.1, letterSpacing: "-0.02em", margin: "0 0 14px", color: "#0c2545" }}>
                A plan that fits your practice
              </h2>
              <p style={{ fontSize: 18, color: "#44566b", margin: 0 }}>
                A flexible subscription model designed for individual clinicians and teams alike. Talk to us for pricing tailored to your setting.
              </p>
            </div>
            <div style={{ maxWidth: 560, margin: "0 auto", background: "#ffffff", border: "1px solid #e6edf3", borderRadius: 20, padding: 44, boxShadow: "0 28px 64px -36px rgba(12,37,69,0.35)", textAlign: "center" }}>
              <div style={{ fontSize: 14, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase", color: "#0c7d72" }}>
                For individual clinicians
              </div>
              <div style={{ fontFamily: "'Libre Franklin', sans-serif", fontWeight: 800, fontSize: 40, color: "#0c2545", margin: "12px 0 6px", letterSpacing: "-0.02em" }}>
                Flexible plans
              </div>
              <p style={{ fontSize: 16.5, color: "#54667a", margin: "0 0 28px" }}>
                Subscriptions that scale with how you work — no long lock-ins, no surprises.
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 13, textAlign: "left", maxWidth: 360, margin: "0 auto 30px" }}>
                {[
                  "Unlimited structured clinical notes & letters",
                  "Works across multiple specialties",
                  "GDPR compliant & NHS-ready",
                ].map((t) => (
                  <div key={t} style={{ display: "flex", gap: 11, alignItems: "center" }}>
                    <span style={{ color: "#10a294" }}><Check /></span>
                    <span style={{ fontSize: 16, color: "#2a3d52" }}>{t}</span>
                  </div>
                ))}
              </div>
              <Link
                to={primaryHref}
                style={{ display: "inline-block", fontSize: 17, fontWeight: 700, color: "#ffffff", background: "#14315c", padding: "14px 32px", borderRadius: 9, ...linkReset }}
              >
                {primaryLabel}
              </Link>
            </div>
          </Container>
        </Section>

        {/* FAQ */}
        <Section id="faq" style={{ padding: "100px 0", background: "#ffffff" }}>
          <Container maxWidth={820}>
            <div style={{ textAlign: "center", marginBottom: 48 }}>
              <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "#0c7d72", marginBottom: 16 }}>
                Frequently asked questions
              </div>
              <h2 style={{ fontFamily: "'Libre Franklin', sans-serif", fontWeight: 800, fontSize: "clamp(30px, 3.6vw, 42px)", lineHeight: 1.1, letterSpacing: "-0.02em", margin: 0, color: "#0c2545" }}>
                Questions, answered
              </h2>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {[
                { q: "Is my patient data secure?", a: "Yes. NoteMD is GDPR compliant and built with patient-data protection as a core principle. Clinical data is handled securely and engineered to meet the requirements of NHS clinical environments." },
                { q: "Does it work with NHS systems?", a: "NoteMD is designed to fit into everyday NHS clinical practice and to meet the requirements of NHS clinical environments. Get in touch and we'll talk through your specific setting." },
                { q: "How accurate is the documentation?", a: "NoteMD structures your dictated or written input without losing clinical meaning or nuance. You always review and sign off the final note, so the clinical word is always yours." },
                { q: "Can I cancel anytime?", a: "Yes. NoteMD runs on a flexible subscription model with no long-term lock-in — scale up or down as your practice needs change." },
                { q: "Which specialties does it support?", a: "NoteMD works across a wide range of specialties and settings — from outpatient clinics to inpatient care and multidisciplinary teams. If your specialty isn't listed, get in touch." },
              ].map(({ q, a }) => (
                <details key={q} style={{ background: "#f7fafc", border: "1px solid #e6edf3", borderRadius: 13, padding: "4px 24px" }}>
                  <summary style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, padding: "20px 0", cursor: "pointer", listStyle: "none" }}>
                    <span style={{ fontFamily: "'Libre Franklin', sans-serif", fontSize: 18, fontWeight: 600, color: "#24384e" }}>{q}</span>
                    <span style={{ flexShrink: 0, fontSize: 26, fontWeight: 300, color: "#10a294", lineHeight: 1 }}>+</span>
                  </summary>
                  <p style={{ fontSize: 16.5, color: "#54667a", margin: "0 0 20px", lineHeight: 1.6 }}>{a}</p>
                </details>
              ))}
            </div>
          </Container>
        </Section>

        {/* FINAL CTA + CONTACT */}
        <Section id="contact" style={{ padding: "100px 0", background: "linear-gradient(160deg, #0c2545 0%, #14315c 100%)", color: "#ffffff" }}>
          <Container style={{ display: "grid", gridTemplateColumns: "1.05fr 0.95fr", gap: 64, alignItems: "center" }}>
            <div>
              <h2 style={{ fontFamily: "'Libre Franklin', sans-serif", fontWeight: 800, fontSize: "clamp(32px, 4vw, 50px)", lineHeight: 1.06, letterSpacing: "-0.025em", margin: "0 0 18px" }}>
                Start documenting smarter with NoteMD
              </h2>
              <p style={{ fontSize: 21, color: "#9fb4c7", margin: "0 0 30px", fontWeight: 500 }}>
                Less typing. More time for patients.
              </p>
              <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
                <Link
                  to={primaryHref}
                  style={{ fontSize: 17, fontWeight: 700, color: "#0c2545", background: "#ffffff", padding: "15px 30px", borderRadius: 9, ...linkReset }}
                >
                  {primaryLabel}
                </Link>
                <a
                  href="mailto:hello@notemd.co.uk"
                  style={{ fontSize: 17, fontWeight: 700, color: "#ffffff", background: "transparent", border: "1.5px solid rgba(255,255,255,0.4)", padding: "14px 28px", borderRadius: 9, ...linkReset }}
                >
                  Request a demo
                </a>
              </div>
            </div>
            <div style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 18, padding: 34 }}>
              <h3 style={{ fontFamily: "'Libre Franklin', sans-serif", fontWeight: 700, fontSize: 20, margin: "0 0 22px", color: "#ffffff" }}>Get in touch</h3>
              <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
                {[
                  { icon: <IconMail />, label: "Email", value: "hello@notemd.co.uk" },
                  { icon: <IconPhone />, label: "Phone", value: "+44 (0)20 0000 0000" },
                  { icon: <IconWeb />, label: "Online", value: "www.notemd.co.uk" },
                ].map((row) => (
                  <div key={row.label} style={{ display: "flex", gap: 14, alignItems: "center" }}>
                    <span style={{ width: 40, height: 40, borderRadius: 10, background: "rgba(79,214,197,0.16)", color: "#4fd6c5", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                      {row.icon}
                    </span>
                    <div>
                      <div style={{ fontSize: 13, color: "#8ea4b8", textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 600 }}>{row.label}</div>
                      <div style={{ fontSize: 16.5, color: "#ffffff", fontWeight: 600 }}>{row.value}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </Container>
        </Section>

        {/* FOOTER */}
        <footer style={{ background: "#0a1f3a", color: "#ffffff", padding: "40px 0" }}>
          <Container style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 24, flexWrap: "wrap" }}>
            <img src="/notemdwhite.png" alt="NoteMD" style={{ height: 40, width: "auto", display: "block" }} />
            <div style={{ fontSize: 14, color: "#7e93a8" }}>
              © 2026 NoteMD — Clinical Documentation Solutions. GDPR compliant &amp; NHS-ready.
            </div>
          </Container>
        </footer>
      </main>

      {/* Responsive tweaks — the design is desktop-first; below is a small-screen fallback */}
      <style>{`
        @media (max-width: 900px) {
          .landing-nav a:not(:last-child) { display: none; }
          .landing-nav { gap: 16px; }
          section [style*="grid-template-columns: 1.05fr 0.95fr"],
          section [style*="grid-template-columns: 0.95fr 1.05fr"],
          section [style*="grid-template-columns: 0.9fr 1.1fr"] {
            grid-template-columns: 1fr !important;
          }
          .landing-demo-grid { grid-template-columns: 1fr !important; gap: 20px !important; }
          .landing-how-grid { grid-template-columns: 1fr !important; gap: 40px !important; }
          .landing-how-grid > div { border-left: 0 !important; border-right: 0 !important; }
          .landing-feature-grid { grid-template-columns: 1fr !important; }
          .landing-testimonial-grid { grid-template-columns: 1fr !important; }
          section [style*="grid-template-columns: 1fr 1fr"] { grid-template-columns: 1fr !important; }
          section [style*="grid-template-columns: repeat(3, 1fr)"] { grid-template-columns: 1fr !important; }
        }
      `}</style>
    </div>
  );
};

export default Landing;
