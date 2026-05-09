# Handoff — Déploiement mappy-hour sur mitch

> Dernière mise à jour : 2026-05-09  
> Session origine : Claude Sonnet 4.6 (plan `tidy-cuddling-feather.md`)

---

## État actuel

### Ce qui fonctionne

| Composant | État |
|-----------|------|
| App Next.js 16 buildée sur mitch | ✅ Build réussi |
| Serveur en cours d'exécution | ✅ PID dans `C:\srv\mappy-hour\server.pid` |
| Accessible dans le tailnet | ✅ `http://100.74.29.33:3000` |
| Atlas download (5 régions) | ⏳ En cours (lancé en background) |
| Tailscale Funnel (HTTPS public) | ❌ À configurer manuellement |
| Docker / WSL2 | ❌ Non installé (dépriorisé) |

### App sur mitch — détails techniques

- **Runtime** : Node.js v20.18.0 portable, installé dans `C:\tools\node-v20.18.0`
- **pnpm** : 9.0.6, installé dans `%APPDATA%\npm`
- **Repo** : `C:\srv\mappy-hour` (cloné depuis `salfab/mappy-hour`, branche `master` + patch `deploy/mitch-zstd-fix` appliqué manuellement sur `src/lib/precompute/sunlight-cache-atlas.ts`)
- **Data root** : `C:\mappy-data` (env `MAPPY_DATA_ROOT=C:\mappy-data`)
- **Cache sunlight** : `C:\mappy-data\cache\sunlight\` (atlas en cours de download)
- **Build flag** : `NEXT_PUBLIC_FORCE_CACHE_ONLY=true` (pas de GPU, pas de precompute)
- **Port** : 3000, bind `0.0.0.0` (accessible sur toutes les interfaces dont Tailscale)
- **Logs** : `C:\srv\mappy-hour\server.log` / `server.err`
- **Script de démarrage** : `C:\temp\mitch-start.ps1`

### Redémarrer le serveur manuellement (si le process est mort)

```powershell
# Via SSH (devops@mitch) ou directement sur mitch
$env:PATH = "C:\tools\node-v20.18.0;$env:APPDATA\npm;" + $env:PATH
Set-Location C:\srv\mappy-hour
$env:NEXT_PUBLIC_FORCE_CACHE_ONLY = "true"
$env:MAPPY_DATA_ROOT = "C:\mappy-data"
$env:PORT = "3000"
pnpm start
# ou en background :
Start-Process powershell -ArgumentList "-NoProfile -File C:\temp\mitch-start.ps1" -WindowStyle Hidden -RedirectStandardOutput C:\srv\mappy-hour\server.log -RedirectStandardError C:\srv\mappy-hour\server.err -PassThru
```

---

## Atlas download — état et reprise

La commande suivante a été lancée en background (session SSH ouverte depuis lappymaclapface) :

```powershell
$env:PATH = "C:\tools\node-v20.18.0;$env:APPDATA\npm;" + $env:PATH
Set-Location C:\srv\mappy-hour
$env:MAPPY_DATA_ROOT = "C:\mappy-data"
pnpm atlas:download -- "--repo=salfab/mappy-hour" "--regions=lausanne,nyon,morges,vevey,geneve" "--release=v9.2.20260509000"
```

- ~32 GB total, ~38 GB libres sur C: au départ du download
- Le script est idempotent : si interrompu, relancer la même commande — il reprend par région
- Output : `C:\mappy-data\cache\sunlight\{region}\...`
- Pour vérifier l'avancement : `Get-ChildItem C:\mappy-data\cache\sunlight -Recurse | Measure-Object Length -Sum`

---

## Tailscale Funnel — à faire manuellement

Le daemon Tailscale sur mitch est détenu par l'utilisateur `Mitch\kiosque`. Les commandes SSH en tant que `devops` ne peuvent pas configurer Tailscale (erreur 401).

**Depuis une session kiosque sur mitch** (RDP, console physique, ou SSH si une clé est configurée) :

```powershell
# 1. Exposer le serveur local via HTTPS Tailscale Funnel
tailscale serve --bg --https=443 http://127.0.0.1:3000
tailscale funnel 443 on

# 2. Vérifier
tailscale serve status
tailscale funnel status
```

**Prérequis dans la Tailscale admin console** (`login.tailscale.com/admin`) :
1. DNS → "HTTPS Certificates" → activé
2. Access Controls → ajouter :
   ```json
   "nodeAttrs": [{ "target": ["mitch"], "attr": ["funnel"] }]
   ```

Après ça, l'app sera accessible publiquement à `https://mitch.<tailnet>.ts.net`.

---

## Code — fix à merger

Un fix critique a été commité sur la branche `deploy/mitch-zstd-fix` (pas encore mergé sur `master`) :

**`src/lib/precompute/sunlight-cache-atlas.ts`** — import de `@mongodb-js/zstd` rendu lazy pour survivre à l'absence du binaire natif (Windows sans build tools). Sans ce fix, `next build` crash lors de la collecte des données de page.

```bash
# Merger localement depuis lappymaclapface
git merge deploy/mitch-zstd-fix
git push origin master
# puis sur mitch : git -C C:\srv\mappy-hour pull
```

---

## Accès SSH à mitch

| Utilisateur | SSH | Notes |
|-------------|-----|-------|
| `devops@mitch` | ✅ Clé ed25519 `fabio@seesharp.ch` | Admin, peut écrire partout |
| `kiosque@mitch` | ❌ Pas de clé configurée | Détient le process Tailscale |

Pour ajouter l'accès SSH à kiosque (à faire manuellement depuis une session kiosque ou admin) :
```powershell
$sshDir = "C:\Users\kiosque\.ssh"
New-Item -ItemType Directory -Force -Path $sshDir
"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAWtLHTO2vJw86iq68BItS4RMQqWVmblI8hJhte7/KS2 fabio@seesharp.ch" | Set-Content "$sshDir\authorized_keys"
icacls "$sshDir\authorized_keys" /inheritance:r /grant "Mitch\kiosque:(F)" /grant "BUILTIN\Administrators:(F)" /grant "NT AUTHORITY\SYSTEM:(F)"
```

---

## Disque C: sur mitch

| | |
|-|-|
| Total | ~128 GB |
| Utilisé | ~84 GB |
| Libre (après atlas ~32 GB) | ~6 GB estimé après download |
| `C:\ESD` | ~20 GB — fichiers upgrade Windows, **safe à supprimer** si besoin d'espace |

Pour supprimer ESD (libère ~20 GB) — depuis une session admin sur mitch :
```powershell
Remove-Item -Recurse -Force C:\ESD
```

---

## Prochaines étapes (par priorité)

1. **Vérifier que l'atlas est bien téléchargé** → relancer si interrompu (commande ci-dessus)
2. **Merger `deploy/mitch-zstd-fix` → master** et faire `git pull` sur mitch
3. **Configurer Tailscale Funnel** depuis la session kiosque
4. **Rendre le serveur persistant au reboot** (Task Scheduler, NSSM, ou autre)
5. **(Optionnel) Migrer vers Docker** — WSL2 + Docker Desktop ou Docker Engine dans WSL2, puis `docker compose up -d`

---

## Fichiers importants

| Fichier | Rôle |
|---------|------|
| `C:\srv\mappy-hour\` | Repo cloné |
| `C:\srv\mappy-hour\.env.local` | Env vars runtime |
| `C:\srv\mappy-hour\server.log` | Logs du serveur Next.js |
| `C:\srv\mappy-hour\server.pid` | PID du process serveur |
| `C:\mappy-data\cache\sunlight\` | Atlas (en cours de download) |
| `C:\tools\node-v20.18.0\` | Node.js portable |
| `C:\temp\mitch-start.ps1` | Script de démarrage du serveur |
| `docs/deploy.md` | Runbook complet (Docker + Tailscale) |
| `.claude/plans/tidy-cuddling-feather.md` | Plan original de déploiement |
