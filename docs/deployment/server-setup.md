# Déploiement headless Node.js natif — guide pas-à-pas (legacy / alternative)

> **Statut :** approche alternative. **Pas utilisée sur mitch** depuis la bascule
> Docker dans WSL2 (2026-05). Ce guide reste valable pour un déploiement
> Node.js natif sur un serveur Ubuntu/Debian sans Docker.
>
> Pour le déploiement actuel (Windows + WSL2 + Docker Engine + image GHCR + Tailscale Funnel),
> voir [`../deploy.md`](../deploy.md).
>
> Reproductible sur n'importe quelle machine Ubuntu/Debian sans GPU Vulkan.
> L'atlas précompute est téléchargé depuis GitHub Releases via `pnpm atlas:download`.

---

## 1. Prérequis système

### Node.js 20 LTS

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v   # → v20.x.x
```

### pnpm 9

```bash
corepack enable
corepack prepare pnpm@9.0.6 --activate
pnpm -v   # → 9.0.6
```

### Dépendances système pour les modules natifs

```bash
sudo apt-get install -y git build-essential python3 libgl1
```

---

## 2. Cloner le repo

```bash
git clone https://github.com/salfab/mappy-hour.git /opt/mappy-hour
cd /opt/mappy-hour
```

---

## 3. Configurer l'environnement

```bash
cp .env.example .env
```

Éditer `.env` :

```dotenv
MAPPY_DATA_ROOT=/data/mappy-hour
```

Créer le répertoire de données :

```bash
sudo mkdir -p /data/mappy-hour
sudo chown $USER:$USER /data/mappy-hour
```

---

## 4. Installer les dépendances Node

```bash
pnpm install --frozen-lockfile
```

---

## 5. Télécharger les atlas précomputes

Télécharge les atlas depuis la dernière GitHub Release et les extrait dans `MAPPY_DATA_ROOT` :

```bash
pnpm atlas:download -- \
  --repo=salfab/mappy-hour \
  --regions=lausanne,nyon,morges,vevey,vevey_city,geneve
```

Options utiles :
- `--release=v9.2.20260509000` — épingler un tag précis au lieu de `latest`
- `--out=/data/mappy-hour` — override du chemin d'extraction

Le script est **idempotent** : il skip les régions déjà installées avec le même `modelVersionHash`.

---

## 6. Builder l'application

```bash
pnpm build
```

---

## 7. Démarrer le serveur

### Test rapide

```bash
pnpm start
# → http://0.0.0.0:3000
```

### Service systemd (production)

Créer `/etc/systemd/system/mappy-hour.service` :

```ini
[Unit]
Description=Mappy Hour — sunlight web app
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/mappy-hour
EnvironmentFile=/opt/mappy-hour/.env
Environment=NODE_ENV=production
Environment=PORT=3000
ExecStart=/usr/bin/pnpm start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now mappy-hour
sudo systemctl status mappy-hour
```

Logs :

```bash
journalctl -u mappy-hour -f
```

---

## 8. Reverse proxy (Nginx)

```nginx
server {
    listen 80;
    server_name mitch.example.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        # SSE : pas de buffering (timeline/stream route)
        proxy_buffering off;
        proxy_cache off;
    }
}
```

---

## 9. Mise à jour de l'atlas (nouvelle release)

```bash
pnpm atlas:download -- \
  --repo=salfab/mappy-hour \
  --regions=lausanne,nyon,morges,vevey,vevey_city,geneve
# → skip si hash déjà installé, télécharge sinon
sudo systemctl restart mappy-hour
```

---

## 10. Mise à jour du code

```bash
cd /opt/mappy-hour
git pull
pnpm install --frozen-lockfile
pnpm build
sudo systemctl restart mappy-hour
```

---

## Déploiement via Docker (recommandé)

Pour la procédure complète (Windows + WSL2 + Docker Engine + Tailscale Funnel),
voir [`../deploy.md`](../deploy.md). Cette section est conservée comme résumé
minimaliste pour un Linux nu.

Voir `Dockerfile` et `.github/workflows/docker-publish.yml` à la racine du repo.
L'image est publiée sur `ghcr.io/salfab/mappy-hour` à chaque push sur `master`.

### Lancer avec Docker Compose

Le `docker-compose.yml` du repo est prêt à l'emploi. Configurer `MAPPY_ATLAS_PATH`
(bind-mount du dossier atlas hôte) dans un `.env` à côté :

```dotenv
# .env
MAPPY_ATLAS_PATH=/data/mappy-hour/cache/sunlight
```

Peupler le bind-mount avant le premier démarrage :

```bash
# Option A : copie depuis une machine de précompute (rsync / robocopy)
# Option B : via le service one-shot atlas-loader (profil "loader")
docker compose --profile loader run --rm atlas-loader \
  --repo=salfab/mappy-hour \
  --regions=lausanne,nyon,morges,vevey,vevey_city,geneve

docker compose up -d
```

> **Note bind-mount** : le compose utilise un bind-mount RO depuis l'hôte
> (`MAPPY_ATLAS_PATH`) plutôt qu'un volume Docker nommé. C'est temporaire — à
> terme, migration vers un volume ext4 propre. Cf. `../deploy.md` section
> "Architecture".

---

## Variables d'environnement disponibles

La liste complète, les flow de configuration, et les méthodes pour passer
les variables au déploiement (Docker, systemd, NSSM, k8s) sont dans
[`environment-config.md`](./environment-config.md).

Minimum vital pour un déploiement headless cache-only :

```dotenv
NODE_ENV=production
PORT=3000
MAPPY_DATA_ROOT=/data/mappy-hour
MAPPY_FORCE_CACHE_ONLY=true
```
