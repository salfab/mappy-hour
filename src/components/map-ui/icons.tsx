"use client";

interface IconProps {
  className?: string;
}

export function SearchIcon({ className = "h-5 w-5" }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

export function ChevronRightIcon({ className = "h-5 w-5" }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

export function ChevronDownIcon({ className = "h-5 w-5" }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

export function SunIcon({ className = "h-5 w-5" }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <circle cx="12" cy="12" r="4.5" fill="#fbbf24" stroke="#f59e0b" />
      <path d="M12 2.5v2" stroke="#f59e0b" />
      <path d="M12 19.5v2" stroke="#f59e0b" />
      <path d="m5 5 1.4 1.4" stroke="#f59e0b" />
      <path d="m17.6 17.6 1.4 1.4" stroke="#f59e0b" />
      <path d="M2.5 12h2" stroke="#f59e0b" />
      <path d="M19.5 12h2" stroke="#f59e0b" />
      <path d="m6.4 17.6-1.4 1.4" stroke="#f59e0b" />
      <path d="m19 5-1.4 1.4" stroke="#f59e0b" />
    </svg>
  );
}

export function CloseIcon({ className = "h-5 w-5" }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

export function BackIcon({ className = "h-5 w-5" }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <path d="m15 18-6-6 6-6" />
    </svg>
  );
}

export function LayersIcon({ className = "h-5 w-5" }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <path d="m12 3 8 4-8 4-8-4 8-4Z" />
      <path d="m4 12 8 4 8-4" />
      <path d="m4 17 8 4 8-4" />
    </svg>
  );
}

export function MountainIcon({ className = "h-5 w-5" }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <path d="m3 19 6.5-11 4 6 2-3 5.5 8H3Z" fill="#bbd7a0" stroke="#24384a" />
      <path d="m9.5 8 1.7 2.5" stroke="#24384a" />
      <path d="m15.5 11 1.4 2" stroke="#24384a" />
      <path d="M6.8 18.8c2.4-2.9 6.9-3.1 10.3-.5" stroke="#7aa35b" strokeWidth="1.5" />
    </svg>
  );
}

export function HeatmapIcon({ className = "h-5 w-5" }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      stroke="none"
      viewBox="0 0 24 24"
    >
      <circle cx="12" cy="12" r="5.8" fill="#fbbf24" opacity="0.62" />
      <circle cx="12" cy="12" r="3.6" fill="#fb923c" opacity="0.82" />
      <circle cx="12" cy="12" r="1.9" fill="#ef4444" />
      <circle cx="6.2" cy="8" r="2" fill="#f59e0b" />
      <circle cx="18" cy="7.5" r="1.9" fill="#f59e0b" />
      <circle cx="18.3" cy="16.5" r="1.7" fill="#8fb06a" />
      <circle cx="5.8" cy="16.6" r="1.6" fill="#8fb06a" />
    </svg>
  );
}

export function LeafOffIcon({ className = "h-5 w-5" }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <path d="M12 21V8" stroke="#24384a" />
      <path d="M8 21h8" stroke="#24384a" />
      <path d="m12 3-4.5 6h2.2L6 14h12l-3.7-5h2.2L12 3Z" fill="#92b86f" stroke="#24384a" />
      <path d="M4 4l16 16" stroke="#24384a" strokeWidth="2.6" />
    </svg>
  );
}

export function TerraceIcon({ className = "h-5 w-5" }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <path d="M4 10a8 8 0 0 1 16 0H4Z" fill="#fbbf24" stroke="#24384a" />
      <path d="M8 10a4 4 0 0 1 4-6 4 4 0 0 1 4 6" stroke="#f59e0b" strokeWidth="1.5" />
      <path d="M12 10v9" stroke="#24384a" />
      <path d="M8 19h8" stroke="#24384a" />
      <path d="M7 14h10" stroke="#24384a" />
      <path d="M8 14v4" stroke="#24384a" />
      <path d="M16 14v4" stroke="#24384a" />
      <path d="M5 21h14" stroke="#fbbf24" />
    </svg>
  );
}
