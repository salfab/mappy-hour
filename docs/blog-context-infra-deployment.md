# Contexte blog — Infra / déploiement / matière première

Fichier de matière première pour un article de blog sur le déploiement de MappyHour.
Pas de mise en forme finale — juste les faits, les anecdotes, les chiffres, les choix.

---

## Le pitch global

MappyHour tourne en production sur un NUC Intel posé quelque part, sans IP publique fixe,
sans abonnement cloud, sans VPS, pour un coût récurrent de 0 CHF/mois (hors électricité).
Stack : Windows 11 + WSL2 + Docker Engine (pas Docker Desktop) + Tailscale + Cloudflare Tunnel.

---

## La machine — Mitch

- **Matériel** : Intel NUC (modèle à confirmer, probablement NUC 12 ou 13 Pro)
- **OS** : Windows 11 Pro
- **Disque** : C: ~118 GB SSD
- **RAM** : suffisante pour faire tourner WSL2 + Docker + un container Next.js
- **Réseau** : derrière NAT (box Internet standard), pas d'IP publique fixe

### Inventaire disque (mai 2026)

| Emplacement | Taille |
|---|---|
| Atlas sunlight (données géospatiales) | ~33 GB |
| Distro Ubuntu WSL2 (VHDX) | ~28 GB brut → 6.7 GB après compact |
| Repo + divers | < 1 GB |

**Anecdote disque** : on a découvert que le fichier VHDX de la distro WSL2 (`ext4.vhdx`)
grossit à chaque `docker pull` mais ne rétrécit jamais automatiquement, même après
`docker system prune`. C'est un VHDX dynamique (sparse) côté Windows — les blocs sont
alloués mais jamais libérés. On avait 28.9 GB pour un ext4 interne qui n'utilisait que
~5 GB. Fix : `diskpart` avec `compact vdisk` après `wsl --shutdown`. Gain : **22 GB
récupérés en quelques minutes**. Pas de cmdlet PowerShell native pour ça (Hyper-V non
installé sur Pro) — `diskpart` est builtin et fait le job.

**Autre chose nettoyée** : Plex Media Server (~20 GB) était installé — désinstallé,
la machine est dédiée à MappyHour.

---

## Pourquoi pas Docker Desktop

Docker Desktop est gratuit pour les projets personnels mais requiert une licence pro
pour un usage professionnel (> 250 employés ou > 10M USD revenus). Plutôt que de
naviguer dans les nuances de licensing, on utilise **Docker Engine directement dans
Ubuntu WSL2**. C'est la même chose sans la GUI, sans le licensing, et sans les
~500 MB d'overhead de l'app Desktop.

---

## Le problème WSL2 qui disparaît toutes les 50 secondes

C'est probablement le bug le plus retors du setup. Symptôme : le container est up,
Tailscale Funnel renvoie des 502 intermittents, et `docker ps` dans WSL répond
parfois, parfois pas. `dmesg` révèle :

```
Operation canceled @p9io.cpp:258 (AcceptAsync)
Received SIGTERM from PID 1 (systemd-shutdow)
```

Cause : WSL2 a un idle timeout (~50s) qui tue la VM quand Windows considère qu'il
n'y a plus d'activité utilisateur côté WSL. **Trois conditions sont nécessaires,
toutes cumulatives** :

1. `/etc/wsl.conf` avec `systemd=true` et `vmIdleTimeout` n'est pas la solution
2. `.wslconfig` avec `vmIdleTimeout=-1` dans le profil **kiosque** (pas devops !)
3. Une **scheduled task** au logon kiosque qui lance `wsl.exe sleep infinity` —
   maintient une invocation `wsl.exe` active en permanence, ce qui empêche le timeout

Sans la 3e condition, les deux premières ne suffisent pas. Le timer de "inactivité"
de Windows ne regarde pas les process dans la VM mais l'absence d'invocation `wsl.exe`
côté host.

---

## Architecture de déploiement

```
Internet
  │
  ▼ HTTPS:443
Cloudflare Edge (TLS terminé ici pour mappyhour.ch)
  │
  ▼ tunnel chiffré sortant (cloudflared sur Mitch)
127.0.0.1:3000 (Windows loopback)
  │
  ▼ NAT WSL2
Container Docker "mappy-hour" (Next.js)
  │
  ▼ bind-mount
C:\mappy-data\cache\sunlight (~33 GB atlas)
```

**En parallèle** (accès interne tailnet uniquement) :
```
Tailscale Funnel → mitch.tail63c42d.ts.net (toujours actif comme fallback)
```

---

## Tailscale — deux usages distincts

### 1. Tailscale Funnel (déploiement initial)

Tailscale Funnel expose un port local publiquement via l'URL `<machine>.<tailnet>.ts.net`.
TLS géré automatiquement. Zéro config réseau. Mais : l'URL est moche et non brandable
(`mitch.tail63c42d.ts.net`).

### 2. Tailscale pour le CI/CD

Le workflow GitHub Actions rejoint le tailnet via un **OAuth client** (pas d'authkey à
rotation manuelle) pour accéder à Mitch en SSH depuis le runner GHA. Élégant : le node
CI est éphémère, tag `tag:ci`, expire à la fin du job.

---

## Custom domain — le chemin vers mappyhour.ch

### Pourquoi pas juste un CNAME vers le tailnet ?

Tentant : `mappyhour.ch CNAME mitch.tail63c42d.ts.net`. Ça route, mais le navigateur
voit un cert TLS pour `*.tail63c42d.ts.net`, pas pour `mappyhour.ch` → erreur de cert.
Pas de moyen d'injecter un cert custom dans Tailscale Funnel.

### Pourquoi pas un VPS ?

Un VPS qui joindrait le tailnet et terminerait TLS pour `mappyhour.ch` fonctionnerait.
Mais ça coûte ~3-6 CHF/mois et ajoute un composant à maintenir.

### Solution : Cloudflare Tunnel (gratuit)

Cloudflare Tunnel (`cloudflared`) crée une connexion **sortante** de Mitch vers
l'edge Cloudflare. Aucun port-forwarding, aucune IP publique. Cloudflare termine TLS
pour `mappyhour.ch` avec son propre cert (géré automatiquement). Coût : 0 CHF.

### Setup via API (100% scriptable)

Le setup a été fait entièrement via API, sans navigateur :

1. **Infomaniak API** : désactiver DNSSEC + changer les nameservers vers Cloudflare
   (découverte : l'API Infomaniak est en v2 pour les domaines, pas v1 — les endpoints
   `/1/domain/*/nameserver` n'existent pas, les bons sont `/2/domains/*/nameservers`)
2. **Cloudflare API** :
   - Trouver le Zone ID (domaine déjà actif après propagation NS en ~20 min)
   - Créer le tunnel : `POST /accounts/{id}/cfd_tunnel`
   - Configurer les règles d'ingress à distance : `PUT /cfd_tunnel/{id}/configurations`
   - Créer les CNAME DNS : `POST /zones/{id}/dns_records`
3. **Sur Mitch via SSH** : télécharger `cloudflared.exe` depuis GitHub releases,
   `cloudflared service install <token>` → service Windows qui démarre automatiquement

Résultat : `https://mappyhour.ch` et `https://www.mappyhour.ch` livres, tunnel
`Status: healthy | Connections: 4` depuis Cloudflare.

**Note winget** : `winget` est installé sur Mitch mais absent du PATH dans les
sessions SSH non-interactives (limitation Windows connue). Téléchargement direct
depuis GitHub releases contourne ça.

---

## Umami — analytics self-hosted sans cookies

Umami est ajouté au `docker-compose.yml` (container `umami` + `umami-db` Postgres).
Le tracker est proxifié par Next.js (`/_analytics/*` → container umami interne) — les
visiteurs ne voient jamais `umami.is`.

**Avantage** : pas de cookies, pas de bannière de consentement GDPR nécessaire.

**Piège vécu** : `UMAMI_DB_PASSWORD` généré en base64 (`openssl rand -base64 24`)
contient des caractères `/`, `+`, `=` qui cassent le parsing de l'URL de connexion
Postgres côté Node.js (`TypeError: Invalid URL`). Le container part en crashloop
silencieux. Fix : utiliser `openssl rand -hex 24` pour ce secret.

**Setup one-time via API** (sans navigateur) : tunnel SSH local vers le port Umami,
login API → récupérer JWT → créer le site → changer le mot de passe admin →
stocker l'UUID dans les secrets GitHub Actions → rebuild image pour bake l'UUID
dans le bundle Next.js client.

---

## CI/CD — GitHub Actions

- **Push master** → build image Docker → push GHCR → deploy sur Mitch via SSH
- Le deploy fait : `git pull` + `docker compose pull` + `docker compose up -d`
- Health checks : `GET /api/datasets` (mappy-hour) + `GET /api/heartbeat` (umami)
- Les secrets Umami (`APP_SECRET`, `DB_PASSWORD`) sont écrits dans `.env.ci` sur
  Mitch par le workflow — la machine ne stocke rien de permanent côté secrets

---

## Chiffres clés

| Item | Coût mensuel |
|---|---|
| Hébergement (NUC) | 0 CHF (machine déjà possédée) |
| Cloudflare Tunnel | 0 CHF (plan gratuit) |
| Cloudflare DNS | 0 CHF |
| Tailscale | 0 CHF (plan personal) |
| Domaine mappyhour.ch | ~15 CHF/an |
| Umami analytics | 0 CHF (self-hosted) |
| **Total récurrent** | **~1.25 CHF/mois** (juste le domaine) |

---

## Angles potentiels pour l'article

- "Self-host en 2026 : ce que personne ne dit sur WSL2 + Docker en prod"
- "De Tailscale Funnel à un vrai domaine : zéro VPS, zéro coût"
- "Setup CI/CD GitHub Actions → NUC perso via Tailscale OAuth"
- Focus sur le debugging WSL2 (le p9io/SIGTERM mystery)
- Focus sur le journey Cloudflare Tunnel entièrement par API
- Le côté "tout dans Docker Compose, analytics inclus, sans cookies"
