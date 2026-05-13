# Notes de déploiement — MappyHour

> **Statut :** déploiement Docker en place sur mitch depuis 2026-05.
> Ce document conserve l'historique des décisions d'archi et liste les écarts
> entre l'archi cible imaginée et l'implémentation effective.
>
> **Source de vérité procédurale (from-scratch + diagnostic) : [`../../docs/deploy.md`](../../docs/deploy.md).**
> Inclut les points critiques découverts après coup : pourquoi Docker tourne en session
> kiosque, les 3 conditions de persistance WSL2 (wsl.conf + .wslconfig + scheduled task),
> SSH `AllowUsers`, hardening container (cap_drop ALL + no-new-privileges + read_only +
> tmpfs, restauré et stable), pattern `scp+ps1`, diagnostic 502 Funnel.
>
> **Bootstrap automatisé** pour une install fresh : `scripts/deploy/mitch-bootstrap.ps1`
> (cf. `scripts/deploy/README.md` et `docs/deploy.md` §0).

---

## Architecture effective (2026-05)

### Image Docker

Une seule image pour l'application Next.js, publiée sur GHCR (publique) :

```
ghcr.io/salfab/mappy-hour:latest
```

Build et push automatiques par `.github/workflows/docker-publish.yml` à chaque
commit `master` et à chaque tag `v*`.

### Stockage atlas — bind-mount Windows (provisoire)

L'archi initialement prévue était un **volume Docker nommé** (`mappy_hour_data`)
hydraté depuis GitHub Releases. En pratique sur mitch on utilise un
**bind-mount Windows → /mnt/c/mappy-data/...** via le pont 9P de WSL2, car :

- L'atlas pèse ~30 GB
- Le copier depuis Windows vers un volume ext4 WSL prend 3h+ (overhead 9P)
- La stratégie atlas shardés (ADR-0024) va changer le format → pas de raison
  d'optimiser la copie tant que ce n'est pas figé

`docker-compose.yml` lit `MAPPY_ATLAS_PATH` (env var, défaut `./data/cache/sunlight`) :

```yaml
volumes:
  - type: bind
    source: ${MAPPY_ATLAS_PATH:-./data/cache/sunlight}
    target: /data/cache/sunlight
    read_only: true
```

Sur mitch : `MAPPY_ATLAS_PATH=/mnt/c/mappy-data/cache/sunlight` dans
`C:\srv\mappy-hour\.env`.

**TODO :** migration vers un volume Docker ext4 propre une fois les atlas
shardés finalisés. Cf. registre des raccourcis (`docs/architecture/shortcuts-registry.md`).

### Services Compose

```
mappy-hour     — Next.js serving, bind-mount atlas en RO
atlas-loader   — one-shot, profil "loader", télécharge depuis GitHub Releases
```

---

## Modes de déploiement

### NUC / serveur sans GPU dédié (cas mitch)

```env
MAPPY_FORCE_CACHE_ONLY=true
MAPPY_DATA_ROOT=/data
MAPPY_ATLAS_PATH=/mnt/c/mappy-data/cache/sunlight
```

Le serveur sert uniquement le cache précompute. Les tuiles manquantes retournent
503 (cf. `docs/runtime-config.md` pour les effets exacts de `MAPPY_FORCE_CACHE_ONLY`).

### Station avec GPU (Vulkan) — non implémenté côté Docker

```env
MAPPY_FORCE_CACHE_ONLY=false
MAPPY_BUILDINGS_SHADOW_MODE=rust-wgpu-vulkan
```

Le serveur peut régénérer à la demande. Requiert le binaire Rust compilé dans
l'image — l'image GHCR actuelle ne le contient pas (build serving-only). Pour
ce mode, exécuter `pnpm start` directement depuis le repo sur une machine GPU
plutôt que via l'image Docker.

---

## UX en cas de cache miss

Quand une zone n'est pas encore couverte, le frontend affiche :

> **Pas encore de soleil par ici**
>
> On n'a pas encore calculé l'ensoleillement pour cette zone.
> Ta recherche est bien notée et nous aide à choisir les prochains coins à couvrir.
>
> Essaie une autre zone en attendant.

Ce message doit se sentir comme une limitation de couverture géographique, pas
comme une erreur technique. Pas de stack trace, pas de "500", pas de spinner
infini.

---

## Scripts en place

| Script | Rôle | Statut |
|--------|------|--------|
| `mitch-deploy-docker.ps1` | `git pull` + `docker compose pull` + `up -d` | ✅ actif (workflow GHA) |
| `mitch-deploy.ps1` | Legacy Node.js natif (build + WMI restart) | ⚠️ legacy, conservé pour rollback |
| `mitch-deploy-no-pull.ps1` | Variante Node.js natif sans `git pull` | ⚠️ legacy |
| `setup-dev-machine.ps1` | Bootstrap dev (clé SSH + Tailscale) | ✅ actif |
| `bootstrap-headless-access.ps1` | Bootstrap serveur (Tailscale + OpenSSH) | ✅ actif |
| `scripts/deploy/setup-tailscale-ci-acl.sh` | Patch idempotent ACL `tag:ci` | ✅ actif |

---

## Prérequis sur le serveur

- Windows 10/11 + WSL2 + Ubuntu (`wsl --install -d Ubuntu --web-download`)
- Docker Engine **dans WSL2 côté session kiosque** (pas Docker Desktop, et **pas dans
  la session devops** — WSL2 + NAT port forwarding sont scoped par session Windows ;
  cf. `docs/deploy.md` §3 « Pourquoi kiosque et pas devops »)
- Persistance WSL2 : trois conditions cumulatives (`/etc/wsl.conf` avec `systemd=true`,
  `C:\Users\kiosque\.wslconfig` avec `vmIdleTimeout=-1`, scheduled task `WslKeepalive`
  au logon kiosque avec `wsl ... --exec /usr/bin/sleep infinity`). Sans la 3e condition,
  la VM cycle ~50s (symptôme : `dmesg | grep p9io` côté WSL).
- Tailscale (login en session interactive `kiosque` pour les commandes `serve`/`funnel`)
- OpenSSH Server (`AllowUsers devops kiosque` — devops pour la clé GHA, kiosque pour
  exécuter les opérations Docker dans la bonne session)
- Image GHCR publique → pas de `docker login` requis

## Hardening compose — restauré

`docker-compose.yml` applique maintenant `cap_drop: ALL`, `security_opt:
no-new-privileges:true`, `read_only: true` et `tmpfs: /tmp`. Validé sur 120s+ avec l'image
courante, Next.js 16 reste healthy (healthcheck `node -e GET /api/datasets`, interval 30s).

Le crashloop transitoire `ELIFECYCLE Command failed.` observé pendant la mise en place
initiale ne s'est pas reproduit après stabilisation de la WSL2 + rebuild de l'image —
probablement lié à des cycles de la VM WSL2 d'avant l'activation systemd, pas à un vrai
manque de capability.

**Seul gap restant** : `user: node` (UID non-root). Avec `read_only` + tmpfs, corepack
échoue sur `/home/node/.cache` (`EACCES`). Pistes : `tmpfs /home/node:uid=1000,gid=1000`,
`ENV COREPACK_HOME=/tmp/corepack` dans le Dockerfile, ou volume scratch. Pas urgent, cf.
`docs/deploy.md` §11.3.
