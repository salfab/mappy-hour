"use client";

import { useState } from "react";

export interface SunlightStyleSettings {
  textureFilter: "smooth" | "pixel";
  showSunny: boolean;
  showShadow: boolean;
  outlineEnabled: boolean;
  outlineWidthPx: number;
  hatchEnabled: boolean;
  hatchSpacingPx: number;
  hatchWobble: number;
  hatchSpaceJitter: number;
}

// DECISION (2026-05-15): defaults aligned with Leaflet's bitmap renderer.
// Leaflet writes pure SUNNY_RGBA / SHADOW_RGBA per cell on a canvas displayed
// via `image-rendering: pixelated` (= NEAREST sampling) with NO outline. To
// match that look out of the box we default to pixel filtering and outline
// off. The user can still flip both back on via this panel.
export const DEFAULT_STYLE_SETTINGS: SunlightStyleSettings = {
  textureFilter: "pixel",
  showSunny: true,
  showShadow: true,
  outlineEnabled: false,
  outlineWidthPx: 2.0,
  hatchEnabled: false,
  hatchSpacingPx: 35,
  hatchWobble: 0.12,
  hatchSpaceJitter: 0.3,
};

interface StylePanelProps {
  settings: SunlightStyleSettings;
  onChange: (next: SunlightStyleSettings) => void;
}

export function StylePanel({ settings, onChange }: StylePanelProps) {
  const [open, setOpen] = useState(false);
  const update = (patch: Partial<SunlightStyleSettings>) =>
    onChange({ ...settings, ...patch });

  return (
    <div className="rounded-xl border border-slate-200 bg-white/80 text-xs">
      <button
        type="button"
        className="flex w-full items-center justify-between rounded-xl px-3 py-2 font-semibold text-slate-700"
        onClick={() => setOpen((o) => !o)}
      >
        <span>Style de l&apos;ombrage</span>
        <span className="text-slate-400">{open ? "▾" : "▸"}</span>
      </button>
      {open ? (
        <div className="space-y-2 px-3 pb-3 pt-1">
          <Row label="Rendu">
            <Radio
              value={settings.textureFilter}
              options={[
                { value: "smooth", label: "Lisse" },
                { value: "pixel",  label: "Pixelisé" },
              ]}
              onChange={(v) => update({ textureFilter: v as "smooth" | "pixel" })}
            />
          </Row>

          <Row label="Soleil jaune">
            <Toggle checked={settings.showSunny} onChange={(showSunny) => update({ showSunny })} />
          </Row>
          <Row label="Ombre bleue">
            <Toggle checked={settings.showShadow} onChange={(showShadow) => update({ showShadow })} />
          </Row>

          <Row label="Bordure noire">
            <Toggle checked={settings.outlineEnabled} onChange={(outlineEnabled) => update({ outlineEnabled })} />
          </Row>
          {settings.outlineEnabled ? (
            <Row label="Épaisseur">
              <Slider min={0.5} max={5} step={0.5} value={settings.outlineWidthPx}
                onChange={(outlineWidthPx) => update({ outlineWidthPx })} />
            </Row>
          ) : null}

          <Row label="Hachures">
            <Toggle checked={settings.hatchEnabled} onChange={(hatchEnabled) => update({ hatchEnabled })} />
          </Row>
          {settings.hatchEnabled ? (
            <>
              <Row label="Espacement">
                <Slider min={15} max={80} step={1} value={settings.hatchSpacingPx}
                  onChange={(hatchSpacingPx) => update({ hatchSpacingPx })} />
              </Row>
              <Row label="Tremblement">
                <Slider min={0} max={0.5} step={0.02} value={settings.hatchWobble}
                  onChange={(hatchWobble) => update({ hatchWobble })} />
              </Row>
              <Row label="Variation d'espacement">
                <Slider min={0} max={0.8} step={0.02} value={settings.hatchSpaceJitter}
                  onChange={(hatchSpaceJitter) => update({ hatchSpaceJitter })} />
              </Row>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid grid-cols-[max-content_1fr] items-center gap-2">
      <span className="text-[11px] text-slate-600">{label}</span>
      <span className="justify-self-end">{children}</span>
    </label>
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={
        "h-5 w-9 rounded-full transition-colors " +
        (checked ? "bg-amber-400" : "bg-slate-300")
      }
      aria-pressed={checked}
    >
      <span
        className={
          "block h-4 w-4 rounded-full bg-white shadow transition-transform " +
          (checked ? "translate-x-4" : "translate-x-0.5")
        }
      />
    </button>
  );
}

function Radio<T extends string>({
  value, options, onChange,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
}) {
  return (
    <span className="inline-flex overflow-hidden rounded-full border border-slate-200">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={
            "px-2 py-0.5 text-[11px] " +
            (o.value === value ? "bg-amber-300 font-semibold text-slate-900" : "bg-white text-slate-600")
          }
        >
          {o.label}
        </button>
      ))}
    </span>
  );
}

function Slider({
  min, max, step, value, onChange,
}: {
  min: number; max: number; step: number; value: number;
  onChange: (v: number) => void;
}) {
  return (
    <span className="inline-flex items-center gap-2">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-24 accent-amber-400"
      />
      <span className="w-10 text-right tabular-nums text-[11px] text-slate-500">
        {value.toFixed(step < 1 ? 2 : 0)}
      </span>
    </span>
  );
}
