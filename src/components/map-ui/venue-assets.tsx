"use client";

import type { VenueType } from "./venue-card";

interface VenueSunStatusInput {
  isSunnyNow: boolean | null;
  sunnyMinutes: number;
}

type VenueSunTone = "sunny" | "shadow" | "window";

interface VenueSunStatus {
  tone: VenueSunTone;
  label: string;
}

export function getVenueSunStatus(place: VenueSunStatusInput): VenueSunStatus {
  if (place.isSunnyNow === true) {
    return { tone: "sunny", label: "Soleil" };
  }

  if (place.isSunnyNow === false) {
    return { tone: "shadow", label: "Ombre" };
  }

  return place.sunnyMinutes > 0
    ? { tone: "window", label: "Créneau" }
    : { tone: "shadow", label: "Ombre" };
}

export function VenueSunStatusIcon(props: { tone: VenueSunTone; className?: string }) {
  const className = props.className ?? "h-4 w-4";

  if (props.tone === "shadow") {
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
        <path d="M4 15a8 8 0 0 1 13.5-5.8" stroke="#64748b" />
        <path d="M18 14.5A5.5 5.5 0 0 1 8.5 18" stroke="#64748b" />
        <path d="M5 5l14 14" stroke="#24384a" />
      </svg>
    );
  }

  if (props.tone === "window") {
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
        <circle cx="12" cy="12" r="3.5" fill="#fbbf24" stroke="#f59e0b" />
        <path d="M12 3v2" stroke="#f59e0b" />
        <path d="M12 19v2" stroke="#f59e0b" />
        <path d="M3 12h2" stroke="#f59e0b" />
        <path d="M19 12h2" stroke="#f59e0b" />
        <path d="M17.7 6.3 16.3 7.7" stroke="#f59e0b" />
        <path d="M6.3 17.7 7.7 16.3" stroke="#f59e0b" />
        <path d="M16 18h5" stroke="#24384a" />
        <path d="M18.5 15.5V20.5" stroke="#24384a" />
      </svg>
    );
  }

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
      <circle cx="12" cy="12" r="4" fill="#fbbf24" stroke="#f59e0b" />
      <path d="M12 2v2" stroke="#f59e0b" />
      <path d="M12 20v2" stroke="#f59e0b" />
      <path d="M2 12h2" stroke="#f59e0b" />
      <path d="M20 12h2" stroke="#f59e0b" />
      <path d="m4.9 4.9 1.4 1.4" stroke="#f59e0b" />
      <path d="m17.7 17.7 1.4 1.4" stroke="#f59e0b" />
      <path d="m4.9 19.1 1.4-1.4" stroke="#f59e0b" />
      <path d="m17.7 6.3 1.4-1.4" stroke="#f59e0b" />
    </svg>
  );
}

export function VenueTerraceIcon(props: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={props.className ?? "h-5 w-5"}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <path d="M4 10a8 8 0 0 1 16 0H4Z" fill="#fbbf24" stroke="#24384a" />
      <path d="M8 10a4 4 0 0 1 8 0" stroke="#f59e0b" strokeWidth="1.5" />
      <path d="M12 10v9" stroke="#24384a" />
      <path d="M7 14h10" stroke="#24384a" />
      <path d="M8 19h8" stroke="#24384a" />
      <path d="M8 14v4" stroke="#24384a" />
      <path d="M16 14v4" stroke="#24384a" />
    </svg>
  );
}

export function VenueTypeIcon(props: { venueType: VenueType; className?: string }) {
  const className = props.className ?? "h-5 w-5";

  if (props.venueType === "bar") {
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
        <path d="M5 4h14l-5.7 7.2a1.7 1.7 0 0 1-2.6 0L5 4Z" fill="#fef3c7" stroke="#24384a" />
        <path d="M7.2 6.8h9.6l-3.8 4.7a1.3 1.3 0 0 1-2 0L7.2 6.8Z" fill="#fbbf24" stroke="#f59e0b" strokeWidth="1.4" />
        <path d="M12 12v7" stroke="#24384a" />
        <path d="M8.5 20h7" stroke="#24384a" />
        <path d="m15.5 4 2.2-2" stroke="#24384a" />
        <circle cx="18.2" cy="2.1" r="1.1" fill="#ef4444" stroke="#24384a" strokeWidth="1.2" />
      </svg>
    );
  }

  if (props.venueType === "restaurant") {
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
        <circle cx="12" cy="12" r="8.2" fill="#fef3c7" stroke="#fbbf24" />
        <path d="M7.4 5.2v6.2" stroke="#24384a" />
        <path d="M5.5 5.2v3.7a1.9 1.9 0 0 0 1.9 1.9" stroke="#24384a" />
        <path d="M9.3 5.2v3.7a1.9 1.9 0 0 1-1.9 1.9" stroke="#24384a" />
        <path d="M7.4 10.8v7.5" stroke="#24384a" />
        <path d="M16.1 5.1c1.6.9 2.5 2.3 2.5 4.1 0 1.9-.9 3.2-2.5 3.8v5.3" stroke="#24384a" />
        <path d="M14.5 5.1v13.2" stroke="#24384a" />
        <path d="M10.8 13.4c1.4.8 3.5.8 4.9 0" stroke="#f59e0b" strokeWidth="1.5" />
      </svg>
    );
  }

  return <VenueTerraceIcon className={className} />;
}

export function venueMarkerClassName(
  venueType: VenueType,
  status: VenueSunTone,
  selected: boolean,
): string {
  return [
    "sunlit-venue-marker",
    `sunlit-venue-marker--${venueType}`,
    `sunlit-venue-marker--${status}`,
    selected ? "sunlit-venue-marker--selected" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function venueTypeMarkerSvg(venueType: VenueType): string {
  if (venueType === "bar") {
    return `
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <path d="M5 4h14l-5.7 7.2a1.7 1.7 0 0 1-2.6 0L5 4Z" fill="#fef3c7" stroke="#24384a"></path>
          <path d="M7.2 6.8h9.6l-3.8 4.7a1.3 1.3 0 0 1-2 0L7.2 6.8Z" fill="#fbbf24" stroke="#f59e0b" stroke-width="1.4"></path>
          <path d="M12 12v7" fill="none" stroke="#24384a"></path>
          <path d="M8.5 20h7" fill="none" stroke="#24384a"></path>
          <path d="m15.5 4 2.2-2" fill="none" stroke="#24384a"></path>
          <circle cx="18.2" cy="2.1" r="1.1" fill="#ef4444" stroke="#24384a" stroke-width="1.2"></circle>
        </svg>`;
  }

  if (venueType === "restaurant") {
    return `
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="8.2" fill="#fef3c7" stroke="#fbbf24"></circle>
          <path d="M7.4 5.2v6.2" fill="none" stroke="#24384a"></path>
          <path d="M5.5 5.2v3.7a1.9 1.9 0 0 0 1.9 1.9" fill="none" stroke="#24384a"></path>
          <path d="M9.3 5.2v3.7a1.9 1.9 0 0 1-1.9 1.9" fill="none" stroke="#24384a"></path>
          <path d="M7.4 10.8v7.5" fill="none" stroke="#24384a"></path>
          <path d="M16.1 5.1c1.6.9 2.5 2.3 2.5 4.1 0 1.9-.9 3.2-2.5 3.8v5.3" fill="none" stroke="#24384a"></path>
          <path d="M14.5 5.1v13.2" fill="none" stroke="#24384a"></path>
          <path d="M10.8 13.4c1.4.8 3.5.8 4.9 0" fill="none" stroke="#f59e0b" stroke-width="1.5"></path>
        </svg>`;
  }

  return `
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <path d="M4 10a8 8 0 0 1 16 0H4Z" fill="#fbbf24" stroke="#24384a"></path>
          <path d="M8 10a4 4 0 0 1 8 0" fill="none" stroke="#f59e0b" stroke-width="1.5"></path>
          <path d="M12 10v8" fill="none" stroke="#24384a"></path>
          <path d="M8 14h8" fill="none" stroke="#24384a"></path>
          <path d="M8.5 18h7" fill="none" stroke="#24384a"></path>
        </svg>`;
}

export function buildVenueMarkerHtml(className: string, venueType: VenueType): string {
  return `
    <span class="${className}">
      <span class="sunlit-venue-marker__halo"></span>
      <span class="sunlit-venue-marker__pin">
        ${venueTypeMarkerSvg(venueType)}
      </span>
    </span>`;
}
