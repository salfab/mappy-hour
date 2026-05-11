import { SunlightMapClient } from "@/components/sunlight-map-client";

export default function Home() {
  return (
    <main className="fixed inset-0 h-dvh max-h-dvh w-full overflow-hidden">
      <SunlightMapClient />
    </main>
  );
}
