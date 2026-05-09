# Déploiement Mappy-Hour from scratch (Windows + Tailscale Funnel)

Procédure reproductible pour déployer mappy-hour sur **n'importe quelle machine Windows 11 Pro** (initialement `mitch`). Toutes les commandes sont en PowerShell admin sauf indication contraire.

## Architecture

```
Internet ──HTTPS:443──▶ <host>.<tailnet>.ts.net  (Tailscale Funnel, edge TLS)
                          │ HTTP loopback
                          ▼
                       127.0.0.1:3000  →  container "mappy-hour"
                                              (Next standalone, non-root, read-only FS)
                                              │
                                              ▼ RO mount
                                          docker volume "mappy-cache"
                                              ▲ RW (one-shot)
                                              │
                                          container "cache-loader"
                                              ↑ télécharge depuis la GitHub Release
```

Pourquoi cette topologie : le container n'écoute que sur loopback (jamais sur le LAN ni sur l'IP tailnet), donc il est inaccessible si Funnel est coupé. Funnel termine TLS publiquement avec un cert auto-géré, sans port forwarding routeur.

---

## Étape 0 — Prérequis

| Requis | Détail |
|---|---|
| OS | Windows 11 Pro (build récent) |
| Compte | Admin local |
| Réseau | Sortie Internet directe (pas de proxy bloquant) |
| Tailnet | Compte ayant droit d'ajouter un node + d'éditer la policy ACL |
| GitHub | Accès en lecture au repo `salfab/mappy-hour` (PAT si privé) |

---

## Étape 1 — Installer Tailscale et joindre le tailnet

```powershell
winget install -e --id Tailscale.Tailscale
# Lancer la GUI une fois, login avec le compte tailnet (salfab@).
tailscale status   # le hostname doit apparaître
```

Sur l'admin console Tailscale (https://login.tailscale.com/admin/) :

1. **DNS → "HTTPS Certificates" : ON** (sinon Funnel ne pourra pas obtenir de cert).
2. **Access controls** — ajouter au policy file :
   ```jsonc
   {
     // ... policy existante ...
     "nodeAttrs": [
       { "target": ["<hostname>"], "attr": ["funnel"] }
     ]
   }
   ```
   Remplacer `<hostname>` par le nom du node (ex. `mitch`). Sauvegarder.
3. Vérifier sur la machine :
   ```powershell
   tailscale cert "$(tailscale status --json | ConvertFrom-Json | % { $_.Self.DNSName.TrimEnd('.') })"
   ```
   Doit produire un fichier `.crt` + `.key` sans erreur.

---

## Étape 2 — Installer WSL2 + Docker Desktop + Git

```powershell
# WSL2 (redémarrage requis après cette commande)
wsl --install
# >>> redémarrer la machine <<<

# Docker Desktop
winget install -e --id Docker.DockerDesktop

# Git
winget install -e --id Git.Git
```

Lancer **Docker Desktop** une fois :
- Accepter l'EULA.
- Settings → General → cocher **"Start Docker Desktop when you log in"**.
- Settings → Resources → WSL Integration : activer pour la distro par défaut.
- Attendre que le moteur soit prêt (icône baleine stable).

Sanity-check :
```powershell
docker version
docker run --rm hello-world
```

> ⚠️ Docker Desktop nécessite une session utilisateur ouverte pour tourner. Si la machine doit servir sans login interactif, installer Docker Engine dans la distro WSL2 directement (`apt install docker.io`) et exposer le socket — non couvert ici.

---

## Étape 3 — Cloner le repo

```powershell
New-Item -ItemType Directory -Force C:\srv | Out-Null
git clone https://github.com/salfab/mappy-hour.git C:\srv\mappy-hour
Set-Location C:\srv\mappy-hour
```

Si la release atlas est privée, créer un PAT GitHub (scope `read:packages` + `repo`) et l'exporter pour la session courante :
```powershell
$env:GITHUB_TOKEN = "ghp_xxx"
```

---

## Étape 4 — Build des images Docker

Deux cibles dans le `Dockerfile` :
- `runtime` : image minimale qui sert l'app (node + standalone, ~150 Mo).
- `loader` : image one-shot avec pnpm/tsx/tar/zstd pour peupler le cache.

```powershell
docker compose build
```

Construit `mappy-hour:latest` et `mappy-hour-loader:latest`.

---

## Étape 5 — Peupler le volume cache depuis la GitHub Release

```powershell
docker compose run --rm cache-loader
# par défaut : --repo=salfab/mappy-hour --regions=lausanne, tag=latest

# pour cibler un tag précis :
docker compose run --rm cache-loader --repo=salfab/mappy-hour --regions=lausanne --tag=atlas-2026-05

# pour plusieurs régions :
docker compose run --rm cache-loader --repo=salfab/mappy-hour --regions=lausanne,nyon
```

Le volume Docker `mappy-cache` est créé au premier `docker compose ... up/run`. Il persiste à travers les redéploiements.

Vérifier :
```powershell
docker run --rm -v mappy-hour_mappy-cache:/data/cache alpine ls -la /data/cache/sunlight
```

---

## Étape 6 — Démarrer le service

```powershell
docker compose up -d
docker ps --filter name=mappy-hour
docker logs -f mappy-hour       # Ctrl-C pour quitter le tail
```

Smoke test local :
```powershell
curl http://127.0.0.1:3000/api/datasets
```

---

## Étape 7 — Brancher Tailscale Funnel

```powershell
tailscale serve --bg --https=443 http://localhost:3000
tailscale funnel 443 on
tailscale serve status
tailscale funnel status
```

L'URL publique sera affichée par `tailscale funnel status`, format :
`https://<hostname>.<tailnet>.ts.net/`

Pour rendre ces commandes persistantes après reboot, Tailscale les sauvegarde automatiquement dans son state (`serve config`) tant que le service Tailscale tourne.

---

## Étape 8 — Validation end-to-end

```powershell
# 1. Local (loopback)
curl http://127.0.0.1:3000/api/datasets

# 2. Tailnet (depuis un autre node)
curl "https://$(tailscale status --json | ConvertFrom-Json | % { $_.Self.DNSName.TrimEnd('.') })/api/datasets"

# 3. Externe — depuis un téléphone en 4G : ouvrir l'URL dans le navigateur, la carte Leaflet doit charger.

# 4. Isolation : depuis un autre node tailnet, tester l'IP directe (DOIT échouer)
curl http://<tailnet-ip-de-ce-node>:3000   # attendu : timeout / refusé

# 5. Headers de sécurité publics
curl -I "https://<host>.<tailnet>.ts.net/"
# Attendu : Strict-Transport-Security, X-Content-Type-Options: nosniff,
#           X-Frame-Options: DENY, Referrer-Policy: strict-origin-when-cross-origin

# 6. Hardening container
docker inspect mappy-hour --format '{{.HostConfig.Privileged}} {{.HostConfig.ReadonlyRootfs}} {{.Config.User}}'
# Attendu : false true 1001 (ou nextjs)

# 7. Healthcheck
docker inspect mappy-hour --format '{{json .State.Health.Status}}'
# Attendu : "healthy"
```

---

## Étape 9 — Maintenance

### Mise à jour code

```powershell
Set-Location C:\srv\mappy-hour
git pull
docker compose build mappy-hour
docker compose up -d mappy-hour
docker image prune -f
```

### Mise à jour atlas (nouvelle GitHub Release)

```powershell
docker compose run --rm cache-loader --tag=<nouveau-tag>
docker compose restart mappy-hour
```

### Logs / debug

```powershell
docker logs -f mappy-hour
tailscale serve status
tailscale funnel status
docker inspect mappy-hour --format '{{json .State.Health}}'
```

### Arrêt / redémarrage

```powershell
docker compose down              # arrête le container, garde le volume
docker compose up -d             # remet en route

tailscale funnel 443 off         # coupe l'exposition publique (le service reste up local)
tailscale serve reset            # nettoie tout le mapping serve+funnel
```

---

## Étape 10 — Hardening (checklist finale)

- [x] `read_only: true` + `tmpfs:/tmp` + `cap_drop: ALL` + `no-new-privileges` (compose).
- [x] User non-root dans le container (UID 1001).
- [x] Bind `127.0.0.1:3000` côté hôte (jamais `0.0.0.0`).
- [x] Volume cache monté en RO côté service.
- [x] Headers Next : HSTS, nosniff, X-Frame-Options DENY, Referrer-Policy strict.
- [x] `poweredByHeader: false`.
- [x] ACL Tailscale : attribut `funnel` limité au seul node concerné.
- [ ] Pas de port forwarding sur le routeur internet (vérifier côté admin réseau).
- [ ] Windows Update + Docker Desktop auto-update + Tailscale auto-update : activés.
- [ ] Sauvegarde / docs du tag atlas en cours d'usage (pour rollback).

---

## Diagnostics rapides

| Symptôme | Investigation |
|---|---|
| `https://...ts.net/` → 502/503 | `docker ps` → mappy-hour running ? `docker logs mappy-hour` |
| `tailscale funnel 443 on` → erreur ACL | Vérifier `nodeAttrs` dans la policy + nom du node |
| `tailscale cert` échoue | Vérifier "HTTPS Certificates" activé dans DNS |
| Cache miss en runtime | `docker exec mappy-hour ls /data/cache/sunlight` ; relancer `cache-loader` |
| Healthcheck unhealthy | `docker inspect mappy-hour --format '{{json .State.Health}}'` |
| Build Docker lent / réseau | Cache pnpm partagé via `--mount=type=cache` du Dockerfile, déjà actif |
| `docker run hello-world` échoue | Docker Desktop pas démarré, ou WSL2 pas activé |
