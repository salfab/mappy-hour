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
    ? { tone: "window", label: "Creneau" }
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
        <path d="M4 15a8 8 0 0 1 13.5-5.8" />
        <path d="M18 14.5A5.5 5.5 0 0 1 8.5 18" />
        <path d="M5 5l14 14" />
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
        <circle cx="12" cy="12" r="3.5" />
        <path d="M12 3v2" />
        <path d="M12 19v2" />
        <path d="M3 12h2" />
        <path d="M19 12h2" />
        <path d="M17.7 6.3 16.3 7.7" />
        <path d="M6.3 17.7 7.7 16.3" />
        <path d="M16 18h5" />
        <path d="M18.5 15.5V20.5" />
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
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2" />
      <path d="M12 20v2" />
      <path d="M2 12h2" />
      <path d="M20 12h2" />
      <path d="m4.9 4.9 1.4 1.4" />
      <path d="m17.7 17.7 1.4 1.4" />
      <path d="m4.9 19.1 1.4-1.4" />
      <path d="m17.7 6.3 1.4-1.4" />
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
      <path d="M4 10a8 8 0 0 1 16 0H4Z" />
      <path d="M12 10v9" />
      <path d="M7 14h10" />
      <path d="M8 19h8" />
      <path d="M8 14v4" />
      <path d="M16 14v4" />
    </svg>
  );
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

export function buildVenueMarkerHtml(className: string): string {
  return `
    <span class="${className}">
      <span class="sunlit-venue-marker__halo"></span>
      <span class="sunlit-venue-marker__pin">
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <path d="M4 10a8 8 0 0 1 16 0H4Z"></path>
          <path d="M12 10v8"></path>
          <path d="M8 14h8"></path>
          <path d="M8.5 18h7"></path>
        </svg>
      </span>
    </span>`;
}
