import type { Metadata } from "next";
import { Fraunces } from "next/font/google";

const fraunces = Fraunces({
  subsets: ["latin"],
  variable: "--font-display",
  axes: ["SOFT", "WONK", "opsz"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Design Lab — Mappy Hour",
  description:
    "Exploration de 3 directions esthétiques 'organic' pour le panel MapLibre desktop.",
};

export const dynamic = "force-static";

// Faux contenu — on ne câble rien, on regarde juste les pixels. Chaque carte
// présente la même information : un en-tête tabs Carte/Terrasses, un sélecteur
// de jour, un CTA "Calculer", trois rangées de toggles, et une mini-timeline.
// Les 3 variantes ne diffèrent que par la palette + typo + bordures + ombres.

function Variant({
  title,
  blurb,
  cssVars,
  cardClass,
  hairlineClass,
  headerTabsClass,
  primaryCtaClass,
  toggleOnClass,
  toggleOffClass,
  labelClass,
  weekdayClass,
  dateClass,
  pastilleClass,
  sectionLabelClass,
  sliderTrackClass,
  sliderFillClass,
  sliderThumbStyle,
}: {
  title: string;
  blurb: string;
  cssVars?: React.CSSProperties;
  cardClass: string;
  hairlineClass: string;
  headerTabsClass: string;
  primaryCtaClass: string;
  toggleOnClass: string;
  toggleOffClass: string;
  labelClass: string;
  weekdayClass: string;
  dateClass: string;
  pastilleClass: string;
  sectionLabelClass: string;
  sliderTrackClass: string;
  sliderFillClass: string;
  sliderThumbStyle: React.CSSProperties;
}) {
  return (
    <div style={cssVars} className="flex flex-col gap-4">
      {/* Variant title — outside the card so we can see "the artefact" alone */}
      <div className="px-1">
        <h2 className="font-[var(--font-display)] text-2xl font-medium tracking-tight text-slate-800">
          {title}
        </h2>
        <p className="mt-1 text-sm text-slate-500">{blurb}</p>
      </div>

      {/* The card itself — replicates the MapLibre side panel layout */}
      <div className={`flex flex-col gap-4 rounded-[1.75rem] p-5 ${cardClass}`}>
        {/* Tabs */}
        <div className={`grid grid-cols-2 gap-1 rounded-2xl p-1 ${headerTabsClass}`}>
          <button
            type="button"
            className="rounded-xl bg-[var(--surface-active,white)] px-3 py-2 text-sm font-medium text-[var(--ink-strong,#0f172a)] shadow-sm"
          >
            Carte
          </button>
          <button
            type="button"
            className="rounded-xl px-3 py-2 text-sm font-medium text-[var(--ink-muted,#64748b)]"
          >
            Terrasses <span className="ml-1 text-xs opacity-60">20</span>
          </button>
        </div>

        {/* Day selector */}
        <div
          className={`flex items-center gap-3 rounded-[1.75rem] px-3 py-3 ${cardClass.includes("inset-glass") ? "" : ""} ${hairlineClass}`}
          style={{ background: "var(--surface-soft, rgba(255,255,255,0.5))" }}
        >
          <span className={`grid h-14 w-14 shrink-0 place-items-center rounded-full ${pastilleClass}`}>
            <svg viewBox="0 0 24 24" className="h-8 w-8" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="12" cy="12" r="4" />
              <path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.4 1.4M17.6 17.6 19 19M5 19l1.4-1.4M17.6 6.4 19 5" strokeLinecap="round" />
            </svg>
          </span>
          <span className="grid min-w-0 flex-1 gap-0.5">
            <span className={weekdayClass}>Dimanche</span>
            <span className={`flex min-w-0 items-center gap-2 ${dateClass}`}>
              <span className="min-w-0 whitespace-normal break-words">16 décembre</span>
              <svg viewBox="0 0 20 20" className="h-5 w-5 shrink-0 opacity-60" fill="currentColor">
                <path d="M5.5 7.5 10 12l4.5-4.5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" />
              </svg>
            </span>
          </span>
        </div>

        {/* Calculate CTA — auto-width, right-aligned. The action is clearly
            tied to the day selector above; the verb "Calculer" is enough on
            its own once the day picker carries the noun ("…l'ensoleillement
            de Dimanche 16 décembre"). Smaller footprint frees vertical
            rhythm for the toggles below. */}
        <div className="flex justify-end">
          <button
            type="button"
            className={`inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-sm font-semibold shadow-sm transition ${primaryCtaClass}`}
          >
            <span aria-hidden>↻</span>
            <span>Calculer</span>
          </button>
        </div>

        {/* Mode selector — Ensoleillement/Heatmap is a mutex toggle (segmented),
            Relief sits next to it as an independent layer toggle. */}
        <div className="flex gap-2">
          <div
            role="radiogroup"
            aria-label="Mode d'affichage"
            className={`flex flex-1 gap-1 rounded-2xl p-1 ${headerTabsClass}`}
          >
            <button
              type="button"
              role="radio"
              aria-checked="true"
              className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-[var(--surface-active,white)] px-3 py-2 text-xs font-medium text-[var(--ink-strong,#0f172a)] shadow-sm"
            >
              <span aria-hidden>☀</span>
              <span>Ensoleillement</span>
            </button>
            <button
              type="button"
              role="radio"
              aria-checked="false"
              className="flex flex-1 items-center justify-center gap-1.5 rounded-xl px-3 py-2 text-xs font-medium text-[var(--ink-muted,#64748b)]"
            >
              <span aria-hidden>🔥</span>
              <span>Heatmap</span>
            </button>
          </div>
          <button
            type="button"
            aria-pressed="false"
            className={`flex items-center gap-1.5 rounded-2xl px-3 py-2 text-xs font-medium ${toggleOffClass}`}
            title="Afficher le relief"
          >
            <span aria-hidden>⛰</span>
            <span>Relief</span>
          </button>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <button type="button" className={`flex flex-col items-center gap-1.5 rounded-2xl p-3 ${toggleOffClass}`}>
            <span aria-hidden className="text-xl">🌲</span>
            <span className="text-xs font-medium">Sans arbres</span>
          </button>
          <button type="button" className={`flex flex-col items-center gap-1.5 rounded-2xl p-3 ${toggleOnClass}`}>
            <span aria-hidden className="text-xl">☕</span>
            <span className="text-xs font-medium">Terrasses</span>
          </button>
        </div>

        {/* Category chips */}
        <div className="flex flex-wrap gap-1.5">
          {[
            { e: "☕", l: "Cafés" },
            { e: "🍺", l: "Bars" },
            { e: "🍴", l: "Restos" },
            { e: "📍", l: "Autres" },
          ].map((c) => (
            <button
              key={c.l}
              type="button"
              className={`flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ${toggleOnClass}`}
            >
              <span aria-hidden>{c.e}</span>
              <span>{c.l}</span>
            </button>
          ))}
        </div>

        {/* Section header — Timeline */}
        <div className="mt-2 grid gap-2">
          <div className="flex items-baseline justify-between">
            <h3 className={sectionLabelClass}>Timeline</h3>
            <span className={`${labelClass} tabular-nums`}>14:30</span>
          </div>
          {/* Slider mock */}
          <div className={`relative h-1.5 rounded-full ${sliderTrackClass}`}>
            <div className={`absolute inset-y-0 left-0 w-[56%] rounded-full ${sliderFillClass}`} />
            <div
              className="absolute top-1/2 size-4 -translate-y-1/2 rounded-full shadow"
              style={{ left: "calc(56% - 8px)", ...sliderThumbStyle }}
            />
          </div>
          <p className={`${labelClass} text-xs`}>Cache only inactif.</p>
        </div>

        {/* Style accordion (closed) */}
        <button
          type="button"
          className={`flex items-center justify-between rounded-2xl px-3 py-2.5 text-sm font-medium ${toggleOffClass}`}
        >
          <span>Style de l&apos;ombrage</span>
          <span aria-hidden className="opacity-50">▸</span>
        </button>
      </div>
    </div>
  );
}

export default function DesignLabPage() {
  return (
    <main
      className={`${fraunces.variable} min-h-dvh bg-[radial-gradient(ellipse_120%_80%_at_50%_-10%,#fffaf2,transparent_60%),linear-gradient(180deg,#fbf6ec_0%,#f3ece1_100%)] pb-24`}
    >
      {/* Header strip */}
      <header className="px-6 pt-10 pb-8 md:px-12">
        <p className="font-[var(--font-display)] text-xs uppercase tracking-[0.35em] text-amber-700/80">
          Design lab · 2026-05-16
        </p>
        <h1 className="mt-2 font-[var(--font-display)] text-4xl font-medium tracking-tight text-stone-900 md:text-5xl">
          Trois lumières pour un même panneau
        </h1>
        <p className="mt-3 max-w-2xl text-sm text-stone-600 md:text-base">
          Le panel desktop de MapLibre, décliné en trois ambiances « organic /
          naturel / soft ». Même contenu, même hiérarchie — la palette, la
          typographie et les textures changent. Choisir une direction, puis
          appliquer.
        </p>
      </header>

      {/* Three variants — responsive grid */}
      <section className="grid gap-10 px-6 md:grid-cols-2 md:px-12 xl:grid-cols-3">
        {/* ─── Variant A — Papier kraft d'hiver (hybride: typo date + timeline de B) ─── */}
        <Variant
          title="A · Papier kraft d'hiver"
          blurb="Le panneau est une feuille de papier épaisse, légèrement crème, sur laquelle le soleil de décembre laisse une empreinte ambrée. Hairlines ambrées, ombres chaudes. La date passe en Fraunces light grand calibre (style éditorial épuré), et le label TIMELINE en uppercase tracking pour rester dans le vocabulaire signaux."
          cssVars={{
            ["--surface-active" as never]: "#fffdf7",
            ["--surface-soft" as never]: "rgba(255, 251, 240, 0.65)",
            ["--ink-strong" as never]: "#1f1a14",
            ["--ink-muted" as never]: "#7a6a55",
          }}
          cardClass="border border-amber-200/50 bg-[oklch(0.985_0.018_85)/0.78] shadow-[0_30px_60px_-30px_rgba(146,107,40,0.25),0_8px_20px_-12px_rgba(146,107,40,0.18)] backdrop-blur-xl"
          hairlineClass="border border-amber-200/40"
          headerTabsClass="bg-amber-900/[0.04]"
          primaryCtaClass="bg-gradient-to-b from-amber-400 to-amber-500 text-amber-950 hover:from-amber-300 hover:to-amber-400 shadow-amber-900/20"
          toggleOnClass="bg-amber-100/80 text-amber-900 ring-1 ring-amber-200/70"
          toggleOffClass="bg-white/60 text-stone-700 ring-1 ring-amber-100/60 hover:bg-amber-50/80"
          labelClass="text-stone-500"
          weekdayClass="text-xs font-medium uppercase tracking-[0.18em] text-stone-500"
          dateClass="font-[var(--font-display)] text-2xl font-light leading-tight tracking-tight text-stone-900"
          pastilleClass="bg-amber-100 text-amber-600"
          sectionLabelClass="text-xs font-semibold uppercase tracking-[0.18em] text-stone-500"
          sliderTrackClass="bg-amber-100/70"
          sliderFillClass="bg-gradient-to-r from-amber-300 to-amber-500"
          sliderThumbStyle={{
            background: "linear-gradient(135deg, #fde68a, #f59e0b)",
            boxShadow: "0 2px 8px rgba(146,107,40,0.35)",
          }}
        />

        {/* ─── Variant B — Soleil minimal ─── */}
        <Variant
          title="B · Soleil minimal"
          blurb="Galerie d'art : blanc cassé propre, une seule touche d'ambre franc, beaucoup d'espace. Fraunces uniquement sur les grands signes (date, timeline). Hairlines presque invisibles. L'amber-400 fait office de signature visuelle, isolée."
          cssVars={{
            ["--surface-active" as never]: "#ffffff",
            ["--surface-soft" as never]: "rgba(255, 255, 255, 0.7)",
            ["--ink-strong" as never]: "#0f172a",
            ["--ink-muted" as never]: "#64748b",
          }}
          cardClass="border border-slate-200/40 bg-white/85 shadow-[0_30px_60px_-30px_rgba(15,23,42,0.18),0_6px_16px_-10px_rgba(15,23,42,0.12)] backdrop-blur-xl"
          hairlineClass="border border-slate-200/60"
          headerTabsClass="bg-slate-100/70"
          primaryCtaClass="bg-amber-400 text-slate-900 hover:bg-amber-300 shadow-amber-500/20"
          toggleOnClass="bg-amber-50 text-amber-900 ring-1 ring-amber-200/60"
          toggleOffClass="bg-white text-slate-700 ring-1 ring-slate-200/70 hover:bg-slate-50"
          labelClass="text-slate-500"
          weekdayClass="text-xs font-medium uppercase tracking-[0.18em] text-slate-500"
          dateClass="font-[var(--font-display)] text-2xl font-light leading-tight tracking-tight text-slate-900"
          pastilleClass="bg-amber-100 text-amber-500"
          sectionLabelClass="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500"
          sliderTrackClass="bg-slate-200/80"
          sliderFillClass="bg-amber-400"
          sliderThumbStyle={{
            background: "#fbbf24",
            boxShadow: "0 0 0 4px rgba(251, 191, 36, 0.2)",
          }}
        />

        {/* ─── Variant C — Lavaux crépuscule ─── */}
        <Variant
          title="C · Lavaux crépuscule"
          blurb="Le couchant sur Lavaux : terre cuite, olive sourde, lavande pâle. Fraunces partout, y compris sur le corps en taille modeste. Saturé sans crier. Le panneau a une présence — il appartient au paysage."
          cssVars={{
            ["--surface-active" as never]: "#fbf7ef",
            ["--surface-soft" as never]: "rgba(243, 232, 211, 0.55)",
            ["--ink-strong" as never]: "#2a221c",
            ["--ink-muted" as never]: "#7c6f5e",
          }}
          cardClass="border border-stone-300/50 bg-[oklch(0.94_0.018_85)/0.82] shadow-[0_30px_60px_-30px_rgba(60,40,20,0.28),0_8px_22px_-14px_rgba(60,40,20,0.18)] backdrop-blur-xl"
          hairlineClass="border border-stone-300/40"
          headerTabsClass="bg-stone-900/[0.05]"
          primaryCtaClass="bg-gradient-to-b from-[#c97a3a] to-[#a85e22] text-amber-50 hover:from-[#d2864a] hover:to-[#b86a30] shadow-[#7a4220]/30"
          toggleOnClass="bg-[#e9d8b0]/70 text-[#5a4626] ring-1 ring-[#c9a874]/40 font-[var(--font-display)]"
          toggleOffClass="bg-stone-50/70 text-stone-700 ring-1 ring-stone-300/50 hover:bg-stone-100/80 font-[var(--font-display)]"
          labelClass="font-[var(--font-display)] text-stone-500"
          weekdayClass="font-[var(--font-display)] text-xs italic uppercase tracking-[0.18em] text-stone-500"
          dateClass="font-[var(--font-display)] text-xl font-medium italic leading-snug text-stone-900"
          pastilleClass="bg-[#e9d8b0] text-[#a85e22]"
          sectionLabelClass="font-[var(--font-display)] text-base font-medium italic tracking-tight text-stone-700"
          sliderTrackClass="bg-stone-300/60"
          sliderFillClass="bg-gradient-to-r from-[#c97a3a] to-[#a85e22]"
          sliderThumbStyle={{
            background: "linear-gradient(135deg, #d6a467, #a85e22)",
            boxShadow: "0 2px 8px rgba(60,40,20,0.4)",
          }}
        />
      </section>

      {/* Decoder footer */}
      <footer className="mx-6 mt-16 max-w-3xl rounded-3xl border border-stone-200/70 bg-white/55 p-6 backdrop-blur-md md:mx-12">
        <p className="font-[var(--font-display)] text-xs uppercase tracking-[0.35em] text-stone-500">
          Critères de lecture
        </p>
        <ul className="mt-3 grid gap-2 text-sm text-stone-700 md:grid-cols-2">
          <li>
            <strong className="text-stone-900">Palette</strong> — chaleur du
            fond, contraste du CTA, hairlines (visibles ou non).
          </li>
          <li>
            <strong className="text-stone-900">Typographie</strong> — quand
            Fraunces apparaît : tout, big numbers seulement, ou titres.
          </li>
          <li>
            <strong className="text-stone-900">Densité</strong> — chaque
            variante respecte le même grid d&apos;information.
          </li>
          <li>
            <strong className="text-stone-900">Ambiance</strong> — papier vs
            galerie vs paysage. Choisir une émotion, pas une couleur.
          </li>
        </ul>
      </footer>
    </main>
  );
}
