import { SunlightMapClient } from "@/components/sunlight-map-client";

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-7xl flex-col gap-8 px-6 py-10 md:px-10">
      <header className="space-y-3">
        <p className="inline-flex rounded-full border border-white/20 px-3 py-1 text-xs tracking-wide text-sky-200">
          Mappy Hour - Lausanne + Nyon
        </p>
        <h1 className="text-4xl font-semibold tracking-tight md:text-5xl">
          Carte d&apos;ensoleillement relief + batiments
        </h1>
        <p className="max-w-4xl text-base text-slate-300 md:text-lg">
          Le backend combine horizon transfrontalier (Suisse + France), modele
          terrain local et ombres batiments pour afficher les zones ensoleillees
          sur la carte.
        </p>
      </header>

      <SunlightMapClient />

      <section className="grid gap-4 rounded-2xl border border-white/15 bg-white/5 p-5">
        <h2 className="text-xl font-semibold">Endpoints actifs</h2>
        <div className="space-y-2 text-sm">
          <code className="block rounded bg-black/40 px-3 py-2">
            POST /api/sunlight/point
          </code>
          <code className="block rounded bg-black/40 px-3 py-2">
            POST /api/sunlight/area
          </code>
          <code className="block rounded bg-black/40 px-3 py-2">
            GET /api/datasets
          </code>
          <code className="block rounded bg-black/40 px-3 py-2">
            GET /api/places
          </code>
          <code className="block rounded bg-black/40 px-3 py-2">
            POST /api/places/windows
          </code>
        </div>
      </section>
    </main>
  );
}
