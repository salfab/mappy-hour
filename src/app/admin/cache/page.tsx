import Link from "next/link";

import { CacheAdminClient } from "@/components/cache-admin-client";

export default function CacheAdminPage() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-7xl flex-col gap-6 px-6 py-10 md:px-10">
      <header className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="space-y-2">
          <p className="inline-flex rounded-full border border-white/20 px-3 py-1 text-xs tracking-wide text-sky-200">
            Admin - Cache
          </p>
          <h1 className="text-4xl font-semibold tracking-tight md:text-5xl">
            Pilotage du cache d&apos;ensoleillement
          </h1>
        </div>
        <Link
          href="/"
          className="inline-flex rounded-full border border-white/15 px-4 py-2 text-sm text-slate-100 transition hover:border-sky-300/50 hover:bg-sky-400/10"
        >
          Retour à la carte
        </Link>
      </header>

      <CacheAdminClient />
    </main>
  );
}
