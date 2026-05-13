# ADR-0025 — Données OSM via Overpass en pré-fetch statique

Statut : Accepté

Date : 2026-05-13

## Contexte

MappyHour a besoin d'un jeu de POIs pour deux usages :

1. **Pre-sélection** des tuiles à précomputer (les zones avec ≥ 1 terrasse candidate).
2. **Overlay** des établissements + parcs sur la carte côté client (cf. discussion en cours sur le rendu progressif L0/L1/L2 des marqueurs).

11 régions cibles (Lausanne, Nyon, Morges, Vevey, Vevey city, Genève, Neuchâtel, La Chaux-de-Fonds, Berne, Zurich, Thun) → ~7 000 POIs au total après normalisation.

Pas d'API gratuite avec couverture exhaustive des terrasses en Suisse → OpenStreetMap, interrogé via Overpass.

## Décision

**Pré-fetch statique** plutôt qu'API runtime côté client.

Pipeline en place :

- **Ingest** : `scripts/ingest/download-places-osm.ts` interroge Overpass au build time (filtre `leisure=park` + `amenity~"^(cafe|bar|pub|restaurant|biergarten|fast_food|food_court)$"`). Multi-endpoint fallback (`overpass-api.de`, `overpass.kumi.systems`, `overpass.openstreetmap.fr`, `maps.mail.ru/osm/tools/overpass`) avec retry sur 429 (back-off 15s × tentative).
- **Versioning** : GitHub release `places-vX.Y.Z` publiée par `scripts/release/publish-places.ts` (semver auto-bump).
- **Distribution** : bake dans l'image Docker via le Dockerfile (couche dédiée près de la fin, cache-friendly) + propagation runtime fail-soft via `scripts/runtime/check-places-update.mjs` (timeout 5s, exit 0 quoi qu'il arrive).
- **Refresh** : cron hebdomadaire (`publish-places.yml`, lundi 03:00 UTC) — les POIs évoluent lentement, weekly est largement suffisant.

Le cache normalisé est consommé par :

- `/api/places/suggest` et `/api/places/windows` pour le typeahead et la sélection.
- L'événement SSE `event: places` dans `/api/sunlight/timeline/stream`.
- Indirectement par la pré-sélection de tuiles précomputables.

### Options écartées

**A. Overpass en runtime côté client (`fetch` direct vers `overpass-api.de`)**. Rejet :

- Rate-limiting agressif (HTTP 429 à quelques requêtes/min/IP). Inopérable à l'échelle d'une vue de carte avec pan/zoom.
- Latence 500ms - 5s selon endpoint et heure → UX dégradée.
- Dépendance externe en hot path : indisponibilité Overpass = carte vide.

**B. Overpass en runtime côté serveur (proxy backend avec cache Redis/KV)**. Rejet :

- Apporte une dépendance externe en hot path (toujours le même rate-limiting au démarrage du cache à froid).
- Coût d'infra cache supplémentaire, pas amorti par le volume MappyHour.
- Pas plus frais qu'un refresh hebdo : les terrasses n'apparaissent pas du jour au lendemain.

**C. Fournisseur commercial (Google Places, Mapbox, HERE)**. Rejet :

- Coût récurrent à la requête (pricing par tile/pageview).
- ToS restrictifs sur l'usage data hors carte commerciale (Google Places n'autorise pas le stockage long-terme des résultats).
- Couverture `outdoor_seating` souvent **moins riche** qu'OSM en Suisse romande, parce que les contributeurs OSM tagguent activement les terrasses.

## Sémantique des tags OSM pour terrasse

C'est le point d'attention principal de cette ADR : **le tagging OSM pour "terrasse" n'est pas évident**.

### Tag canonique

- **`outdoor_seating=yes`** est le seul tag officiellement documenté sur le wiki OSM ([Key:outdoor_seating](https://wiki.openstreetmap.org/wiki/Key:outdoor_seating)) pour signaler une terrasse au sens HORECA (Hôtellerie, Restauration, Cafés).

### Couverture pratique

- Empiriquement, ~30-50% des établissements pertinents en Suisse romande portent ce tag. **Absence de tag ≠ absence de terrasse**, c'est juste un défaut de couverture cartographique.
- Cette incertitude est déjà gérée en aval par `sunlight-map-client.tsx` via la `selectionStrategy: "original" | "terrace_offset" | "indoor_fallback"` qui contourne les cas non taggés.

### Faux amis dans `download-places-osm.ts:130-133`

Le code actuel marque `hasOutdoorSeating=true` si **n'importe lequel** des trois tags suivants vaut `yes` :

```ts
const hasOutdoorSeating =
  tags.outdoor_seating === "yes" ||
  tags["terrace"] === "yes" ||
  tags["garden"] === "yes";
```

- `terrace=yes` n'a **pas** de sémantique HORECA officielle ; le wiki OSM l'utilise plutôt pour un toit-terrasse architectural sur un `building=*`. Sur un `amenity=bar`, faux positifs probables.
- `garden=yes` n'a **pas** de sémantique HORECA non plus. `leisure=garden` existe comme entité, mais pas en tant qu'attribut sur un POI HORECA.

Décision : à nettoyer dans un commit séparé (out of scope de cette ADR), ne garder que `outdoor_seating === "yes"` et introduire un troisième état `hasOutdoorSeatingUnknown` (tag absent) distinct de `false` (tag présent et = no). Permet à l'UI de distinguer "terrasse confirmée" / "probable" / "indoor seulement".

### Tags annexes utiles non encore capturés

À considérer pour des filtres futurs :

- `outdoor_seating:covered=yes/no/partial` — terrasse couverte (utile pour filtrer "soleil direct possible vs garanti").
- `outdoor_seating:heated=yes` — chauffage extérieur (pertinent hors saison).
- `smoking=outside` — proxy faible mais non nul d'existence d'un espace extérieur.

Pas d'urgence à les ajouter, mais le format normalisé `NormalizedPlace` doit pouvoir les accueillir sans migration de schéma quand le besoin viendra (les tags raw sont déjà conservés dans `tags: Record<string, string>` du `NormalizedPlace`, donc l'élargissement est juste applicatif).

## Conséquences

### Avantages

- **Coût opérationnel nul** : Overpass est gratuit, l'image GitHub Container Registry l'est aussi pour un repo public.
- **Aucune dépendance externe en runtime** : MappyHour fonctionne offline / airgapped (cf. ADR-Posture 4) ; Overpass ne touche que le hot path *build*, jamais le hot path *requête*.
- **Refresh asynchrone** : le cron hebdo absorbe naturellement le rate-limiting et les rares 503 Overpass.
- **Contrôle complet du format normalisé** (`NormalizedPlace`) : indépendant des évolutions internes d'Overpass.

### Inconvénients

- **Couverture inégale par région** : Suisse romande bien couverte, Suisse alémanique moins (à mesurer région par région avant d'étendre le scope).
- **Faux négatifs sur la classe "terrasse confirmée"** : conséquence directe du défaut de couverture `outdoor_seating`.
- **Maintenance manuelle des tags** dans `download-places-osm.ts:130-133` quand on étend la liste (cf. faux amis ci-dessus).
- **Multi-endpoint fallback obligatoire** : si tous les mirrors Overpass tombent en même temps, le `publish-places` cron échoue. Acceptable vu la fréquence hebdo (un cron raté = on retente la semaine suivante).

## Conditions d'invalidation

À rebencher / revisiter si :

- **Couverture OSM `outdoor_seating` chute < 20%** sur une région cible (à mesurer dans un script `scripts/diag/bench-osm-coverage.ts` futur si on étend à de nouvelles villes).
- **Nouvelle source authoritative apparaît** (registre cantonal des établissements public-facing, dataset open data swisstopo/canton avec terrasses, etc.) → migration vers un mix possible.
- **Coût d'un fournisseur commercial devient acceptable** ET sa couverture dépasse OSM dans les régions cibles.
- **MappyHour bascule en produit grand public** avec >10k DAU et l'archive hebdo OSM ne tient plus le rythme des nouvelles ouvertures de terrasses (latence d'apparition > 1 semaine devient un problème UX) → considérer un endpoint runtime cache-aside.
- **Overpass change ses ToS** (rate-limiting plus strict, monétisation, etc.) → revoir l'équilibre vs option C.

## Suivi (issues / tâches)

- [x] Nettoyer `download-places-osm.ts:130-133` : retirer `terrace=yes` et `garden=yes` du `hasOutdoorSeating`, introduire `hasOutdoorSeatingUnknown`. Bump `places-v0.2.0`. **Fait 2026-05-13** (commit 2174fd4 + release `places-v0.2.0`).
- [x] Capturer `outdoor_seating:covered` et `:heated` dans `NormalizedPlace` (ajouts non-breaking au schema). **Fait 2026-05-13** (commit e1a60b2).
- [ ] (Si overlay carto se concrétise) Script `scripts/diag/bench-osm-coverage.ts` qui mesure le ratio `hasOutdoorSeating / amenity=cafe|bar|...` par région et alerte si < 20%.
