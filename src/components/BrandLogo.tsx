// NoteMD brand assets.
// - BrandMark: compact document-with-check icon matching the logo (navy page + teal check).
//   Used in the collapsed sidebar and anywhere a small square mark is needed.
// - BrandLockup: the full horizontal logo image (icon + wordmark + tagline).

const NAVY = "#163a63";
const TEAL = "#19b3a6";

export const BrandMark = ({
  className,
  tone = "brand",
}: {
  className?: string;
  tone?: "brand" | "light";
}) => {
  // On dark backgrounds ("light" tone) the page outline/lines render white;
  // the teal check stays teal so it still reads as the brand.
  const lineColor = tone === "light" ? "#ffffff" : NAVY;
  const pageFill = tone === "light" ? "none" : "white";
  return (
    <svg
      viewBox="0 0 48 48"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role="img"
      aria-label="NoteMD"
    >
      {/* document page */}
      <rect
        x="9"
        y="8"
        width="23"
        height="31"
        rx="3.5"
        fill={pageFill}
        stroke={lineColor}
        strokeWidth="2.5"
      />
      {/* text lines */}
      <line x1="14" y1="15.5" x2="24" y2="15.5" stroke={lineColor} strokeWidth="2" strokeLinecap="round" />
      <line x1="14" y1="20.5" x2="22" y2="20.5" stroke={lineColor} strokeWidth="2" strokeLinecap="round" />
      <line x1="14" y1="25.5" x2="19" y2="25.5" stroke={lineColor} strokeWidth="2" strokeLinecap="round" />
      {/* teal check sweeping out of the page */}
      <path
        d="M16 29.5 L23 36 L39 17"
        stroke={TEAL}
        strokeWidth="4.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
};

// Full colour logo lockup — for light backgrounds (sidebar, platform).
export const BrandLockup = ({ className }: { className?: string }) => (
  <img
    src="/notemdcolor.png"
    alt="NoteMD — Clinical Documentation Solutions"
    className={className}
  />
);

// All-white logo lockup — for dark backgrounds (login hero panel).
export const BrandLockupWhite = ({ className }: { className?: string }) => (
  <img
    src="/notemdwhite.png"
    alt="NoteMD — Clinical Documentation Solutions"
    className={className}
  />
);

export default BrandMark;
