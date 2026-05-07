# ADR-0012 - Backend d'ombrage runtime : ANGLE + loop swap vs. Vulkan batch consolidé

**Date** : 2026-04-17
**Statut** : Proposé (décision à prendre)
**Références** : ADR-0011 (décisions Vulkan précompute), commits `d2363a6` (loop swap places/windows), `513b3e3` (tile lookup fast path)

## Contexte

La route `/api/sunlight/timeline/stream` cache-only est désormais 9.5× plus rapide (199s → 21s sur Lausanne 161 tuiles) grâce au format binaire des artefacts.

La route `/api/places/windows` a deux modes :

1. **Fast path — tile lookup** (commit `513b3e3`) : quand la place tombe dans une tuile précomputée, on lit directement les bits `sunMask`/`sunMaskNoVeg` du cache binaire. Zéro GPU. ~3-4s pour 100 places × 60 samples.

2. **Slow path — GPU fallback** : quand la tuile n'est pas précomputée (place en périphérie), on utilise `buildPointEvaluationContext` + `evaluateInstantSunlight`. Ça tourne sur le backend `gpu-raster` (ANGLE/WebGL, shadow map 4096×4096 + `gl.readPixels`). Chaque `prepareSunPosition` coûte ~30-55ms.

Le commit `d2363a6` améliore le slow path en inversant l'ordre des boucles (sample-outer, place-inner) pour mutualiser les shadow maps entre places proches — gain mesuré **5-6× sur 10 places**, extrapolé à **~100× sur 100 places**.

Mais un autre backend existe déjà dans le codebase : **`rust-wgpu-vulkan`**, utilisé pour le précompute. Il fait un compute dispatch batch qui évalue N points pour 1 angle soleil en parallèle sur GPU (voir ADR-0011 Phase D/E). Le même dispatch qui rend la précompute 4.35× plus rapide pourrait aussi accélérer le slow path runtime.

**Question** : doit-on consolider le runtime sur le backend Vulkan/batch déjà utilisé par le précompute, ou garder la séparation actuelle (ANGLE au runtime, Vulkan pour le précompute) ?

## Mesures actuelles

Route `/api/places/windows`, date=2026-04-11, bbox avec mix tile-hit/tile-miss :

| Scope | Tile hits | Tile miss (GPU) | Wall (warm) |
|---|---|---|---|
| bbox 100% dans cache (100 places × 60 samples) | 99 | 1 | 3.4s |
| bbox mixte (50 places × 60 samples) | 40 | 10 | 4.5s |
| bbox hors cache (extrapolation 100 places × 60 samples) | 0 | 100 | ~3.6s (60 renders × 60ms) |

Le slow path avec loop swap plafonne autour de **60 × ~55 ms = 3.3 s** pour n'importe quel nombre de places, grâce à l'idempotence de `prepareSunPosition` sur 1° d'arrondi (places proches en 5km partagent les mêmes angles arrondis).

## Options

### Option A — Garder ANGLE + loop swap (état actuel, commit `d2363a6`)

**Comment ça marche** : `MAPPY_BUILDINGS_SHADOW_MODE=gpu-raster` reste le mode de production pour le runtime. Le slow path `/api/places/windows` utilise l'ordre sample-outer + idempotence de `prepareSunPosition` pour mutualiser les renders.

**Avantages** :
- Déjà livré et mesuré (~5-100× selon le nombre de fallback places)
- Aucune dépendance externe supplémentaire (ANGLE est intégré à Node via `headless-gl`)
- Le subprocess Rust Vulkan reste réservé au précompute (background job)
- Pas de cold-start runtime : l'endpoint HTTP doit répondre vite, or Vulkan demande ~2s de boot la première fois

**Inconvénients** :
- Duplication architecturale : deux backends d'ombre coexistent (gpu-raster via ANGLE pour runtime, rust-wgpu-vulkan pour précompute)
- Le code du slow path en TS duplique partiellement ce que le shader Vulkan fait déjà (horizon mask lookup, ray-march vegetation — même si ici le slow path le fait en CPU/JS)
- Le plafond de performance est ~3.3s par requête (60 renders), alors que Vulkan batch pourrait descendre à ~0.5s

### Option B — Consolider sur le backend Vulkan/batch

**Comment ça marche** : `/api/places/windows` slow path utilise `getOrCreateRustWgpuVulkanBackend` (déjà exporté par `evaluation-context.ts`). Pour chaque sample, on collecte les coordonnées des places fallback dans un tableau, on envoie un seul dispatch batch `evaluate({points: [...], sunAz, sunAlt})`, et on récupère un array de bits blocked/sunny.

**Avantages** :
- Un seul backend canonique pour précompute ET runtime — plus de divergence de sémantique
- Performance théorique **~200×** vs état pré-swap : 60 dispatches × ~10ms compute = 600ms pour 100 places × 60 samples
- Réutilise l'infrastructure existante : serveur Rust long-lived, reload_mesh/reload_focus, horizon/vegetation uploadés par zone (ADR-0011 Phase B/C)
- La boucle TS disparaît complètement — juste un accumulateur de résultats

**Inconvénients** :
- Coût de démarrage Vulkan : ~2s pour le premier `reload_mesh` sur une nouvelle focus zone. Pour un utilisateur qui fait une requête ponctuelle, c'est ajouté en latence.
- Le subprocess Rust alloue ~500 MB pour les buffers Vulkan, tenu pendant toute la durée de vie du serveur Node. Multiplier par 2 (précompute + runtime) n'a pas de sens ; il faudra soit mutualiser l'instance, soit gérer le focus change runtime/précompute (car le précompute tourne sur des focus zones alors que le runtime a les siennes).
- Le driver Vulkan Intel Arc est instable (voir `processus-developpement-optimisation-rex.md`) — une crash du subprocess au runtime casse l'endpoint, alors qu'une crash pendant le précompute redémarre juste un job.
- Le MVP doit refactorer `/api/places/windows` pour : (a) détecter que Vulkan est dispo, (b) gérer le cas où Vulkan plante → fallback sur ANGLE, (c) router les lv95Bounds pour setFrustumFocus, (d) gérer l'API batch de retour.
- L'env var `MAPPY_BUILDINGS_SHADOW_MODE` est un toggle global aujourd'hui. Faire cohabiter les deux backends demande soit un nouveau mode `hybrid`, soit de détecter la dispo de Vulkan indépendamment du mode.
- Effort estimé : 2-3 jours de dev + validation (vs 0 pour Option A déjà livrée).

### Option C — Statu quo + tile-lookup coverage

**Comment ça marche** : on ne touche plus au backend runtime. À la place, on précompute plus de tuiles dans les régions utilisées, pour que le tile lookup couvre 100% des places en pratique.

**Avantages** :
- Zéro refactor backend runtime
- Les gains précompute (ADR-0011) bénéficient automatiquement
- Le slow path devient un fallback vraiment exceptionnel (places vraiment en dehors de la zone couverte)

**Inconvénients** :
- Data work : il faut définir quelles zones précomputer (coûte en heures compute + disque) — non bloquant pour le code
- Ne résout pas le problème pour les requêtes UI qui sortent de la zone précomputée pour explorer

## Critères de décision

1. **UX attendue** : quel est le SLA cible de `/api/places/windows` pour une requête "hors cache" typique ? Si l'utilisateur n'explore que Lausanne centre, Option A suffit amplement. Si on attend à des requêtes sur des zones non-précomputées (Nyon, Morges, Genève et au-delà), Option B vaut le coup.

2. **Stabilité Vulkan** : est-ce qu'on accepte qu'un plantage du driver Intel Arc fasse tomber l'endpoint runtime ? Aujourd'hui le risque est limité au précompute (retry de job, pas d'impact user). Mettre Vulkan au runtime augmente la surface d'incident.

3. **Charge concurrente** : un seul subprocess Vulkan peut-il servir N requêtes parallèles ? Le protocole IPC actuel est séquentiel (1 pending à la fois). Multi-tenant = nouveau chantier.

4. **Couverture précompute prévue** : si on planifie de précomputer >99% des zones utiles (Option C), le slow path devient négligeable et l'optimisation backend runtime n'a plus de sens.

## Proposition

**Garder Option A pour l'instant** et re-évaluer Option B quand l'un de ces signaux apparaît :

- Des utilisateurs explorent régulièrement des zones non-précomputées, et leur latence dégrade mesurablement l'UX (logs `[places/windows]` montrent des requêtes >5s).
- On prévoit de supporter des régions non-CH (Lavaux, France voisine) où le précompute complet serait prohibitif et le slow path deviendrait le mode commun.
- Le driver Vulkan Intel Arc devient stable (ou on bascule sur une carte avec driver solide).

**En parallèle**, Option C : continuer à étendre le précompute pour limiter la surface du slow path.

## Conséquences

### Option A figée (recommandée)

- `MAPPY_BUILDINGS_SHADOW_MODE=gpu-raster` reste le mode runtime de production
- Le loop swap de `d2363a6` est le plafond de perf runtime en attendant
- La route `/api/places/windows` a deux chemins de code (fast path tile lookup + slow path GPU)

### Option B retenue plus tard

- Il faudra introduire un `MAPPY_RUNTIME_SHADOW_BACKEND` distinct de `MAPPY_BUILDINGS_SHADOW_MODE` (précompute)
- Le subprocess Vulkan devra être multiplexé ou instancié deux fois (RAM ~1 GB)
- La route `/api/places/windows` slow path fera un call batch unique au lieu de 60 appels `evaluateInstantSunlight`
- Un test de charge concurrent sera nécessaire avant rollout

## Mesures de référence au moment de la décision

(warm cache, date 2026-04-11, grille 1m, sample 15min, Lausanne)

| Scénario | Commit | Wall |
|---|---|---|
| Pre-optim (`buildSharedPointEvaluationSources` per-place) | avant `60bd8e5` | 7.7s / 20 places |
| Shared sources réutilisé | `60bd8e5` | 2.4s / 20 places |
| Tile lookup fast path | `513b3e3` | 3.4s / 100 places × 60 samples (fully in cache) |
| + loop swap GPU fallback | `d2363a6` | 4.5s / 50 places × 60 samples (10 fallback) |
