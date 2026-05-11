# Configuration par environnement

> **Principe d'architecture immuable** : un seul build artifact (image Docker ou
> `pnpm build`) tourne dans tous les environnements. La configuration spécifique
> à chaque cible est injectée **au démarrage** via des variables d'environnement.
> Aucune variable n'est inlinée à la compilation — changer un flag = redémarrer,
> jamais rebuild.

---

## Variables d'environnement runtime

### Serving web (Next.js)

| Variable | Défaut | Effet | Recommandation par environnement |
|---|---|---|---|
| `MAPPY_DATA_ROOT` | `./data` (relatif au repo) | Racine du cache atlas, places, raw, processed | **Toujours** un chemin absolu hors repo en prod (`/data/mappy-hour`, `C:\mappy-data`) |
| `MAPPY_CACHE_SUNLIGHT_DIR` | `$MAPPY_DATA_ROOT/cache/sunlight` | Override **seulement** du cache sunlight (atlas + shards + idx). Utile si l'atlas est sur un disque séparé du reste. | Laisser vide en prod |
| `MAPPY_FORCE_CACHE_ONLY` | `false` | Force tout l'app en lecture-seule depuis l'atlas. Effets :<br>• page server-side passe `forceCacheOnly=true` au client → diagnostics au click désactivés<br>• `/api/sunlight/point` et `/api/sunlight/instant/stream` retournent 503<br>• `/api/sunlight/timeline/stream` ignore le param client et force `cacheOnly=true`<br>• `/api/places/windows` skip le fallback GPU plutôt que de crasher | **`true` sur tout serveur sans GPU** (Mitch, headless cloud). `false` sur les machines de précompute. |
| `MAPPY_TIMELINE_CACHE_PREFETCH` | `4` (Linux) / `1` (Windows headless) | Nombre de tuiles lues en parallèle pour la timeline cache-only. Plus haut = plus rapide mais plus de RAM/IO. | `1` sur petite VM avec disque lent (Mitch NUC), `8-16` sur serveur SSD beefy |
| `MAPPY_ATLAS_MEMORY_CACHE_ENTRIES` | (cf. code) | Nombre de tuiles atlas gardées en mémoire entre requêtes. `0` = désactivé. | `0` sur petite VM ; laisser défaut sinon |
| `MAPPY_ATLAS_COMPRESSION` | auto-detect | `zstd` ou `gzip` — forcer le format de compression du précompute (lecture toujours auto) | Laisser vide |
| `PORT` | `3000` | Port d'écoute du serveur Next.js | Laisser `3000` derrière reverse proxy |
| `NODE_ENV` | — | `production` désactive les warnings dev et active les optims React | Toujours `production` en prod |
| `STAC_BASE_URL` | `https://data.geo.admin.ch/api/stac/v0.9` | URL pour télécharger les sources swisstopo (precompute uniquement) | Laisser défaut sauf mirror interne |

### Précompute (machines GPU uniquement)

Ces variables ne sont **pas pertinentes** sur un serveur de serving — ne pas les
mettre dans le `.env` d'un déploiement headless. Elles sont consommées par
les scripts `pnpm precompute:*` et `pnpm benchmark:*`.

| Variable | Effet |
|---|---|
| `MAPPY_BUILDINGS_SHADOW_MODE` | `cpu` / `gpu-raster` / `rust-wgpu-vulkan` / `detailed` |
| `MAPPY_PRECOMPUTE_WORKERS` | Nombre de workers parallèles (cf. ADR-0019 : `1` forcé pour Vulkan) |
| `MAPPY_TILE_PIPELINE_DEPTH` | Profondeur du pipeline tile-first (sweet spot : `3` post-Phase-E) |
| `MAPPY_RUST_WGPU_*` | Tuning du backend Vulkan (sessions, focus margin, profile) |
| `MAPPY_VHM_PYTHON` | Path vers `python.exe` pour les scripts VHM |

### Déploiement / release

| Variable | Effet |
|---|---|
| `GITHUB_TOKEN` | Pour `pnpm atlas:download` sur repo privé (sinon CLI publique anonyme) |

---

## Flow de configuration (qui lit quoi)

```
┌─────────────────────────────────────────────────────────────────┐
│ MAPPY_FORCE_CACHE_ONLY=true (set in .env, systemd, container)   │
└────────────────────┬────────────────────────────────────────────┘
                     │
       ┌─────────────┼─────────────┐
       ▼             ▼             ▼
  ┌─────────┐  ┌──────────┐  ┌───────────┐
  │ page.tsx│  │API routes│  │/api/places│
  │ (server)│  │ (server) │  │ (server)  │
  └────┬────┘  └──────────┘  └───────────┘
       │
       │ prop forceCacheOnly={true}
       ▼
  ┌────────────────────┐
  │ SunlightMapClient  │  ← skip diagnostics click,
  │ (client component) │    hide cache-only button
  └────────────────────┘
```

- **Page server-rendered** (`src/app/page.tsx` avec `export const dynamic = "force-dynamic"`) lit `process.env.MAPPY_FORCE_CACHE_ONLY` à chaque requête HTTP et passe le flag au composant client en prop.
- **Routes API** lisent `process.env.MAPPY_FORCE_CACHE_ONLY` directement à chaque requête.
- **Client (navigateur)** ne lit jamais d'env var — il reçoit le flag par prop server-side. C'est ce qui rend l'architecture immuable : aucune valeur n'est baked au build.

---

## Comment passer les variables au déploiement

### 1. Docker (méthode recommandée)

#### Option A — env vars en ligne

```bash
docker run -d \
  --name mappy-hour \
  -e MAPPY_DATA_ROOT=/data \
  -e MAPPY_FORCE_CACHE_ONLY=true \
  -e NODE_ENV=production \
  -v /data/mappy-hour:/data \
  -p 3000:3000 \
  ghcr.io/salfab/mappy-hour:latest
```

#### Option B — fichier `.env`

Créer un `.env.production` à côté du compose :

```dotenv
MAPPY_DATA_ROOT=/data
MAPPY_FORCE_CACHE_ONLY=true
NODE_ENV=production
PORT=3000
MAPPY_TIMELINE_CACHE_PREFETCH=1
```

```bash
docker run -d --env-file .env.production -v /data/mappy-hour:/data -p 3000:3000 ghcr.io/salfab/mappy-hour:latest
```

#### Option C — `docker-compose.yml`

Le fichier `docker-compose.yml` du repo est un point de départ. Override par environnement avec un fichier de surcharge :

```yaml
# docker-compose.override.yml (sur le serveur cible, jamais commité)
services:
  mappy-hour:
    environment:
      - MAPPY_FORCE_CACHE_ONLY=true
      - MAPPY_TIMELINE_CACHE_PREFETCH=1
```

`docker compose up -d` charge automatiquement `docker-compose.yml` + `docker-compose.override.yml`.

---

### 2. Bare metal Linux (systemd)

Utiliser `EnvironmentFile=` dans l'unit pour pointer vers un fichier `.env` :

```ini
# /etc/systemd/system/mappy-hour.service
[Unit]
Description=Mappy Hour
After=network.target

[Service]
Type=simple
User=mappy
WorkingDirectory=/opt/mappy-hour
EnvironmentFile=/etc/mappy-hour/env
ExecStart=/usr/bin/pnpm start
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```bash
# /etc/mappy-hour/env (chmod 640, owner mappy:mappy)
NODE_ENV=production
PORT=3000
MAPPY_DATA_ROOT=/data/mappy-hour
MAPPY_FORCE_CACHE_ONLY=true
MAPPY_TIMELINE_CACHE_PREFETCH=4
```

Modifier la config :

```bash
sudo $EDITOR /etc/mappy-hour/env
sudo systemctl restart mappy-hour
```

---

### 3. Bare metal Windows (NSSM)

```powershell
nssm install MappyHour "C:\tools\node-v20.18.0\node.exe" `
  "C:\srv\mappy-hour\.next\standalone\server.js"

nssm set MappyHour AppEnvironmentExtra `
  "NODE_ENV=production" `
  "PORT=3000" `
  "MAPPY_DATA_ROOT=C:\mappy-data" `
  "MAPPY_FORCE_CACHE_ONLY=true" `
  "MAPPY_TIMELINE_CACHE_PREFETCH=1" `
  "MAPPY_ATLAS_MEMORY_CACHE_ENTRIES=0"

nssm start MappyHour
```

Modifier la config :

```powershell
nssm set MappyHour AppEnvironmentExtra "NODE_ENV=production" "MAPPY_FORCE_CACHE_ONLY=false" ...
nssm restart MappyHour
```

Alternative scriptée (cf. `scripts/headless-server-selfhosting/mitch-deploy-no-pull.ps1`) : un `C:\temp\mitch-start.ps1` qui pose les `$env:*` avant `pnpm start`.

---

### 4. Kubernetes

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: mappy-hour-config
data:
  NODE_ENV: production
  PORT: "3000"
  MAPPY_DATA_ROOT: /data
  MAPPY_TIMELINE_CACHE_PREFETCH: "4"
---
apiVersion: v1
kind: Secret
metadata:
  name: mappy-hour-secrets
type: Opaque
stringData:
  MAPPY_FORCE_CACHE_ONLY: "true"  # ou false sur un node avec GPU
---
apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      containers:
        - name: mappy-hour
          image: ghcr.io/salfab/mappy-hour:latest
          envFrom:
            - configMapRef:
                name: mappy-hour-config
            - secretRef:
                name: mappy-hour-secrets
```

---

## Exemples de profils par environnement

### Profil **headless cache-only** (Mitch, cloud VM sans GPU)

```dotenv
NODE_ENV=production
PORT=3000
MAPPY_DATA_ROOT=/data/mappy-hour
MAPPY_FORCE_CACHE_ONLY=true
MAPPY_TIMELINE_CACHE_PREFETCH=1
MAPPY_ATLAS_MEMORY_CACHE_ENTRIES=0
```

### Profil **serveur compute** (machine GPU avec précompute + serving)

```dotenv
NODE_ENV=production
PORT=3000
MAPPY_DATA_ROOT=/data/mappy-hour
MAPPY_FORCE_CACHE_ONLY=false
MAPPY_BUILDINGS_SHADOW_MODE=rust-wgpu-vulkan
MAPPY_PRECOMPUTE_WORKERS=1
MAPPY_TILE_PIPELINE_DEPTH=3
```

### Profil **dev local**

```dotenv
MAPPY_DATA_ROOT=D:\mappy-hour-data
# Aucune autre var requise — le serveur sert depuis le cache présent
# et calcule à la volée ce qui manque (suppose un GPU dispo)
```

---

## Vérifier la config active sur un serveur

### Linux

```bash
sudo systemctl show mappy-hour --property=Environment
sudo cat /proc/$(pidof node)/environ | tr '\0' '\n' | grep ^MAPPY_
```

### Windows (NSSM)

```powershell
nssm get MappyHour AppEnvironmentExtra
```

### Docker

```bash
docker exec mappy-hour env | grep -E '^(MAPPY_|NODE_ENV|PORT)'
```

### Endpoint santé (recommandation future)

Aujourd'hui aucun endpoint n'expose la config active. À ajouter en cas de besoin :
`GET /api/health` retournant `{ cacheOnly: bool, dataRoot: string, node: string }`.

---

## Ce qu'il faut **éviter**

- ❌ **Variables `NEXT_PUBLIC_*`** : elles sont inlinées au build. Une seule existait (`NEXT_PUBLIC_FORCE_CACHE_ONLY`), supprimée le 2026-05-11 au profit de `MAPPY_FORCE_CACHE_ONLY` (runtime).
- ❌ **`ARG` Docker pour config fonctionnelle** : ne JAMAIS passer un comportement applicatif via `--build-arg`. L'image deviendrait spécifique à une cible. Seuls les paramètres de build pur (version Node, miroir npm) sont légitimes en `ARG`.
- ❌ **Commiter des `.env`** : `.env.example` documente, les `.env.production` restent locaux au serveur.
- ❌ **Hardcoder `process.env.MAPPY_*` dans des composants client** : la valeur est `undefined` côté navigateur sauf si baked au build. Toujours passer par la page server-rendered → prop.
