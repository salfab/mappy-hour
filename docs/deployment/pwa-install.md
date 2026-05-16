# PWA — install Mappy Hour on a phone

Mappy Hour ships a Web App Manifest so visitors can pin it as a standalone
app. This is currently **install-only** — there is no service worker yet, so
the app still needs network for every visit.

## What is served

- `public/manifest.webmanifest` — declared via `metadata.manifest` in
  `src/app/layout.tsx` (Next 16 metadata API). Next serves any file under
  `public/` as a static asset, so `/manifest.webmanifest` is reachable as-is.
- `public/icons/icon.svg` — `purpose: "any"` icon used by Android Chrome and
  the apple-touch-icon hint for iOS Safari.
- `public/icons/icon-maskable.svg` — `purpose: "maskable"` icon with an 80%
  safe-zone so Android adaptive-icon masks crop the background cleanly.
- `metadata.appleWebApp` — gives iOS the standalone hints (status bar style,
  short title) when added to the home screen.
- `viewport.themeColor` (`#f59e0b`) — tints the Android status bar and the
  Chrome address bar when launched standalone.

## How users install

- **iOS Safari**: open the Share sheet → *Sur l'écran d'accueil* → *Ajouter*.
  Safari ignores the manifest for the icon choice and uses `apple-touch-icon`
  instead; SVG support is inconsistent on older iOS versions, so the home
  screen may currently fall back to a page screenshot.
- **Android Chrome / Edge**: after a short engagement, Chrome offers an
  *Install app* prompt automatically. Users can also force it via the menu →
  *Installer l'application*. The maskable SVG drives the adaptive icon.
- **Desktop Chrome / Edge**: an install icon appears in the address bar.

## Replacing the placeholder icons

The current SVGs (`public/icons/icon.svg`, `public/icons/icon-maskable.svg`)
are placeholders — amber sun disc on cream, stylised "M". To ship a real
design:

1. Have a designer produce a 512×512 master at `public/icons/icon.svg`.
2. Keep the maskable variant inside a 410×410 safe circle (80% of 512).
3. For maximum iOS fidelity, also export PNGs (`icon-192.png`,
   `icon-512.png`, `icon-180-apple.png`) and add them to the manifest /
   `metadata.icons` block.

## Not yet implemented

- No service worker → no offline access, no background sync, no install
  prompt customisation.
- No PNG icon fallback → iOS home-screen visual is suboptimal.
- No screenshots in the manifest → Chrome won't show a rich install card.
