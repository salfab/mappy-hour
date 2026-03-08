export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-8 px-6 py-12 md:px-10">
      <header className="space-y-3">
        <p className="inline-flex rounded-full border border-white/20 px-3 py-1 text-xs tracking-wide text-sky-200">
          Mappy Hour - Lausanne
        </p>
        <h1 className="text-4xl font-semibold tracking-tight md:text-5xl">
          Moteur d&apos;ensoleillement relief + batiments 3D
        </h1>
        <p className="max-w-3xl text-base text-slate-300 md:text-lg">
          Stack Next.js avec ingestion automatisee des donnees swisstopo pour
          Lausanne, et relief transfrontalier pour tenir compte des Alpes
          francaises dans l&apos;horizon solaire.
        </p>
      </header>

      <section className="grid gap-4 rounded-2xl border border-white/15 bg-white/5 p-5">
        <h2 className="text-xl font-semibold">Pipeline initial</h2>
        <ol className="list-decimal space-y-1 pl-5 text-slate-200">
          <li>Telecharger swissBUILDINGS3D (Lausanne, bbox locale).</li>
          <li>Telecharger swissALTI3D 2 m (zone locale, precision urbaine).</li>
          <li>
            Telecharger le DEM Copernicus 30 m sur un rayon de 120 km autour de
            Lausanne (Suisse + France).
          </li>
          <li>Construire un masque d&apos;horizon terrain (placeholder en V1).</li>
          <li>
            Interroger l&apos;API `POST /api/sunlight/point` pour une date donnee.
          </li>
        </ol>
      </section>

      <section className="grid gap-4 rounded-2xl border border-white/15 bg-white/5 p-5">
        <h2 className="text-xl font-semibold">Commandes utiles</h2>
        <div className="space-y-2 text-sm">
          <code className="block rounded bg-black/40 px-3 py-2">
            pnpm ingest:lausanne:buildings -- --dry-run --max-items=20
          </code>
          <code className="block rounded bg-black/40 px-3 py-2">
            pnpm ingest:lausanne:terrain:ch -- --dry-run --max-items=20
          </code>
          <code className="block rounded bg-black/40 px-3 py-2">
            pnpm ingest:lausanne:terrain:horizon -- --dry-run
          </code>
          <code className="block rounded bg-black/40 px-3 py-2">
            pnpm preprocess:lausanne:horizon
          </code>
          <code className="block rounded bg-black/40 px-3 py-2">
            curl -X POST http://localhost:3000/api/sunlight/point -H
            &quot;Content-Type: application/json&quot; -d &quot;@payload.json&quot;
          </code>
        </div>
      </section>

      <section className="grid gap-2 rounded-2xl border border-amber-300/40 bg-amber-200/10 p-5 text-sm text-amber-100">
        <h2 className="text-base font-semibold">Statut V1</h2>
        <p>
          Le calcul d&apos;ombres batiments n&apos;est pas encore branche. Cette
          etape est prevue juste apres l&apos;ingestion complete de Lausanne.
        </p>
      </section>
    </main>
  );
}

