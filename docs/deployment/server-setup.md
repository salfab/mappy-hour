# Déploiement headless — guide pas-à-pas (Mitch et équivalents)

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
  --regions=lausanne,nyon,morges,vevey,geneve
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
  --regions=lausanne,nyon,morges,vevey,geneve
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

## Déploiement via Docker

Voir `Dockerfile` et `.github/workflows/docker-publish.yml` à la racine du repo.

L'image est publiée sur `ghcr.io/salfab/mappy-hour` à chaque push sur `master`.

### Lancer avec Docker Compose

```yaml
# docker-compose.yml
services:
  mappy-hour:
    image: ghcr.io/salfab/mappy-hour:latest
    ports:
      - "3000:3000"
    volumes:
      - /data/mappy-hour:/data
    environment:
      - MAPPY_DATA_ROOT=/data
    restart: unless-stopped
```

Avant le premier démarrage, télécharger les atlas dans `/data/mappy-hour` :

```bash
# Sur la machine hôte (pas dans le conteneur)
cd /opt/mappy-hour
MAPPY_DATA_ROOT=/data/mappy-hour pnpm atlas:download -- \
  --repo=salfab/mappy-hour \
  --regions=lausanne,nyon,morges,vevey,geneve

docker compose up -d
```

---

## Variables d'environnement disponibles

| Variable | Défaut | Description |
|---|---|---|
| `MAPPY_DATA_ROOT` | `./data` | Racine des données (atlas, buildings, DEM) |
| `MAPPY_CACHE_SUNLIGHT_DIR` | `$DATA_ROOT/cache/sunlight` | Override pour le cache atlas uniquement |
| `NEXT_PUBLIC_FORCE_CACHE_ONLY` | `false` | `true` → force le mode "cache uniquement" et masque le bouton dans l'UI. Recommandé sur tout serveur headless sans GPU. |
| `PORT` | `3000` | Port d'écoute Next.js |
| `NODE_ENV` | — | Mettre `production` en prod |
