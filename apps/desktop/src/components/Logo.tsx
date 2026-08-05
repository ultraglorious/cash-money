/** The cash-money brand mark (inline SVG so it inherits crisp scaling + no fetch). */
export function Logo({ size = 34 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" role="img" aria-label="cash-money">
      <defs>
        <linearGradient id="cmGrad" x1="4" y1="4" x2="44" y2="44" gradientUnits="userSpaceOnUse">
          <stop stopColor="#4C6EF5" />
          <stop offset="1" stopColor="#7048E8" />
        </linearGradient>
      </defs>
      <rect x="3" y="3" width="42" height="42" rx="12" fill="url(#cmGrad)" />
      <rect x="11.5" y="16" width="25" height="16" rx="3.5" stroke="white" strokeWidth="2.4" />
      <circle cx="24" cy="24" r="4.4" stroke="white" strokeWidth="2.4" />
      <path
        d="M25.6 21.9c-.5-.5-1.3-.6-1.9-.1-.8.6-.8 2-.8 2.2s0 1.6.8 2.2c.6.5 1.4.4 1.9-.1M21.7 23.4h2.3M21.7 24.7h2"
        stroke="white"
        strokeWidth="1.1"
        strokeLinecap="round"
      />
      <circle cx="15.6" cy="20" r="1.15" fill="white" />
      <circle cx="32.4" cy="28" r="1.15" fill="white" />
    </svg>
  );
}
