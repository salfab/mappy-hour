# Notes de déploiement — MappyHour

> **Statut :** prospectif — rien n'est encore implémenté ici.  
> Ce document décrit l'architecture cible pour le déploiement sur serveur headless.

---

## Architecture cible

### Image Docker

Une seule image pour l'application Next.js, publiée sur GHCR :

```
ghcr.io/salfab/mappy-hour:latest
```

### Volume de données

Un volume Docker nommé contient le cache précompute (atlas de masques solaires) :

```
mappy_hour_data
```

La variable d'environnement `MAPPY_DATA_ROOT=/app/data` pointe vers ce volume dans le conteneur.

### Services Compose

```
cache-init   — hydrate le volume depuis un GitHub Release (run-once)
app          — Next.js, lit/écrit dans le même volume
```

---

## Modes de déploiement

### NUC / serveur sans GPU dédié

```env
MAPPY_CACHE_MISS_MODE=log-only
MAPPY_SHADOW_MODE=cpu
```

Le serveur sert uniquement le cache précompute. Les tuiles manquantes sont notées dans les logs.  
Le calcul à la demande est désactivé.

### Station avec GPU (Vulkan)

```env
MAPPY_CACHE_MISS_MODE=compute-sync
MAPPY_SHADOW_MODE=rust-wgpu-vulkan
```

Le serveur peut régénérer à la demande. Requiert le binaire Rust compilé dans l'image.

---

## UX en cas de cache miss

Quand une zone n'est pas encore couverte, le frontend affiche :

> **Pas encore de soleil par ici**
>
> On n'a pas encore calculé l'ensoleillement pour cette zone.  
> Ta recherche est bien notée et nous aide à choisir les prochains coins à couvrir.
>
> Essaie une autre zone en attendant.

Ce message doit se sentir comme une limitation de couverture géographique, pas comme une erreur technique.  
Pas de stack trace, pas de "500", pas de spinner infini.

---

## Scripts futurs (non implémentés)

| Script | Rôle |
|--------|------|
| `cache-init.ps1` | Télécharge l'archive de cache depuis un GitHub Release, extrait dans le volume |
| `export-cache-volume.ps1` | Exporte le volume vers une archive pour publication en Release |
| `deploy-app.ps1` | Pull l'image GHCR, redémarre le Compose |
| `inspect-cache-misses.ps1` | Lit les logs du mode `log-only`, affiche les tuiles manquantes par région |

---

## Ce qui doit être fait avant de déployer

1. Dockerfile + `.dockerignore` pour l'image Next.js
2. `docker-compose.yml` avec les deux services + volume nommé
3. Workflow GitHub Actions pour build + push GHCR
4. Premier export de cache via `export-cache-volume.ps1`
5. Test end-to-end sur le NUC : `cache-init` → `app` → vérification carte

---

## Prérequis sur le serveur

- Docker Engine (sans Docker Desktop)
- Accès à GHCR (login `docker login ghcr.io`)
- Port 3000 ou 80 ouvert en local (pas besoin d'exposition publique si Tailscale suffit)
