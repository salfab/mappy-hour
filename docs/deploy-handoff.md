# Handoff — Déploiement mappy-hour sur mitch (snapshot historique)

> **LEGACY — Statut au 2026-05-11 :** ce handoff décrit le **déploiement initial en
> Node.js natif via WMI** sur mitch (mai 2026). **Plus utilisé** depuis la bascule
> sur **Docker Engine dans WSL2 + image GHCR**.
>
> **Source de vérité actuelle : [`deploy.md`](./deploy.md).**
>
> Ce document est conservé pour traçabilité (bugs corrigés au moment de la transition,
> justification WMI vs Job Object SSH, état SSH/Tailscale Funnel d'origine).
>
> Dernière mise à jour : 2026-05-10  
> Session origine : Claude Sonnet 4.6 (plan `tidy-cuddling-feather.md`)

---

## État actuel

| Composant | État |
|-----------|------|
| App Next.js buildée sur mitch | ✅ Build réussi |
| Serveur en cours d'exécution | ✅ WMI PID 15484, survit aux déconnexions SSH |
| Tailscale Funnel (HTTPS public) | ✅ `https://mitch.tail63c42d.ts.net` |
| Atlas (5 régions) | ✅ lausanne 877t, nyon 14t, morges 28t, vevey 88t, geneve 463t |
| Places OSM (terrasses) | ✅ `lausanne-places.json` (708 KB) + `nyon-places.json` (147 KB) |
| API sunlight/timeline/stream | ✅ Fonctionnel (bug `findCachedModelVersionHash` corrigé) |
| API places/windows | ✅ Fonctionnel (bug GPU fallback + tile lookup corrigés) |
| **Décompression atlas zstd** | ❌ `@mongodb-js/zstd` prébuilt non installé sur mitch — run `mitch-install-zstd-native.ps1` après pull |
| Persistance au reboot | ❌ Non configuré (process WMI ne survit pas au reboot) |

---

## App sur mitch — détails techniques

- **Runtime** : Node.js v20.18.0 portable → `C:\tools\node-v20.18.0`
- **pnpm** : 9.0.6 → `%APPDATA%\npm`
- **Repo** : `C:\srv\mappy-hour` (branch `master`, commit `3882947`)
- **Data root** : `C:\mappy-data` (`MAPPY_DATA_ROOT=C:\mappy-data`)
- **Atlas** : `C:\mappy-data\cache\sunlight\{region}\{hash}\g1\atlas\r0.75\`
- **Places** : `C:\mappy-data\processed\places\lausanne-places.json` + `nyon-places.json`
- **Runtime flag** : `MAPPY_FORCE_CACHE_ONLY=true` (lu au démarrage par la page server-rendered ; aucun rebuild nécessaire en cas de modif)
- **Port** : 3000, bind `0.0.0.0`
- **Logs** : `C:\srv\mappy-hour\server.log` / `server.err`
- **PID** : `C:\srv\mappy-hour\server.pid`
- **Script de démarrage** : `C:\temp\mitch-start.ps1`

---

## Déployer une mise à jour (commande unique)

> **Obsolète depuis la bascule Docker (2026-05).** Le script courant est
> `mitch-deploy-docker.ps1` (`git pull` + `docker compose pull` + `docker compose up -d`)
> et le déploiement est piloté par GitHub Actions (`.github/workflows/deploy-mitch.yml`).
> Conservé ci-dessous pour mémoire :

```powershell
# Ancien flow Node.js natif (legacy)
ssh devops@mitch "powershell -File C:\srv\mappy-hour\scripts\headless-server-selfhosting\mitch-deploy.ps1"
```

Le script fait : `git pull` → `pnpm install` → `pnpm build` (~3 min) → kill + redémarrage WMI.

---

## Bugs corrigés dans cette session (récapitulatif)

| Commit | Fix |
|--------|-----|
| `bedce17` | Mode UI par défaut `daily` au lieu d'`instant` |
| `bedce17` | `PRECOMPUTED_REGIONS` : ajout de `vevey` |
| `3882947` | **`findCachedModelVersionHash`** : le `catch { continue }` sautait le check atlas pour les déploiements atlas-only (dossier `g1/m15/` absent → `readdir` ENOENT → `continue` → atlas jamais scanné → `[]` → "No tiles found"). Fix : `dates = []` pour tomber dans le `else { atlas check }`. |
| `6d196de` | **`places/windows` GPU fallback** : `pickViaTile` retournait `null` si un candidat offset (parmi les 17 points à 4m/8m) atterrissait hors couverture atlas → GPU → crash sur raw swisstopo absent. Fix : `continue` le candidat, garder les autres. Garde `MAPPY_FORCE_CACHE_ONLY` devant `ensureSharedSources()` en filet de sécurité. |
| `230379d` | Places OSM embarquées comme assets GitHub Release — `pnpm atlas:publish` ingeste et publie les places JSON, `pnpm atlas:download` les télécharge automatiquement. Plus de dépendance Overpass à l'install. |
| `19a0dc6` | Fix Overpass HTTP 406 (`URLSearchParams` body), 4 endpoints, retry 429 |

---

## Publier une nouvelle release atlas + places

```powershell
# Sur lappymaclapface
pnpm atlas:publish -- --regions=lausanne,nyon
# Puis valider + publier la draft sur GitHub, puis sur mitch :
ssh devops@mitch "powershell -File C:\srv\mappy-hour\scripts\headless-server-selfhosting\mitch-deploy.ps1"
# Et mettre à jour l'atlas + places :
ssh devops@mitch "powershell -Command \"cd C:\srv\mappy-hour; $env:PATH = 'C:\tools\node-v20.18.0;' + `$env:APPDATA + '\npm;' + `$env:PATH; pnpm atlas:download -- --repo=salfab/mappy-hour --regions=lausanne,nyon\""
```

`pnpm atlas:publish` (dans `scripts/release/publish-atlas-release.ps1`) :
1. Ingeste les places OSM (lausanne + nyon) dans un répertoire temp
2. Package les régions atlas (`package-atlas-region.ts`)
3. Construit `release-manifest.json` (inclut les places avec SHA256)
4. Crée la release GitHub en draft + upload les assets

---

## Redémarrer le serveur manuellement (si le process est mort)

```powershell
# Via SSH (devops@mitch)
$cmd = "powershell.exe -NoProfile -File C:\temp\mitch-start.ps1"
$result = (Get-WmiObject -List Win32_Process).Create($cmd)
Write-Host "PID: $($result.ProcessId)"
Set-Content C:\srv\mappy-hour\server.pid $result.ProcessId
```

> **Pourquoi WMI ?** Windows OpenSSH crée un Job Object qui tue tous les enfants à la déconnexion. `Start-Process` lance dans ce Job Object et meurt avec la session. `Win32_Process.Create()` échappe à ce Job Object — le process survit.

Vérification :
```powershell
ssh devops@mitch "Invoke-WebRequest http://127.0.0.1:3000 -UseBasicParsing | Select-Object StatusCode"
```

---

## Tailscale Funnel — état et commandes

**Actif** : `https://mitch.tail63c42d.ts.net` → `http://127.0.0.1:3000`

La configuration Funnel appartient à l'utilisateur `kiosque` (session interactive).
Elle est **persistante** : survit aux redémarrages du daemon Tailscale.

Pour vérifier (depuis une session kiosque ou SSH kiosque si SSH configuré) :
```powershell
tailscale serve status
tailscale funnel status
```

Pour couper/rétablir :
```powershell
tailscale funnel 443 off       # coupe l'accès public
tailscale funnel --bg 3000     # rétablit (nouvelle syntaxe v1.50+)
```

---

## Accès SSH à mitch

| Utilisateur | SSH | Notes |
|-------------|-----|-------|
| `devops@mitch` | ✅ Clé ed25519 `fabio@seesharp.ch` | Admin, déploiements |
| `kiosque@mitch` | ❌ Pas de clé configurée | Détient Tailscale |

Pour ajouter SSH à kiosque (depuis une session admin/kiosque) :
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
| Atlas installé | ~32 GB dans `C:\mappy-data\cache\sunlight\` |
| `C:\ESD` | ~20 GB — fichiers upgrade Windows, safe à supprimer si besoin |

```powershell
Remove-Item -Recurse -Force C:\ESD   # libère ~20 GB
```

---

## Persistance au reboot (TODO)

Le process WMI ne redémarre pas automatiquement après un reboot Windows. Options :

**Option A — Task Scheduler (sans droits admin supplémentaires)** :
```powershell
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -File C:\temp\mitch-start.ps1"
$trigger = New-ScheduledTaskTrigger -AtStartup
Register-ScheduledTask -TaskName "MappyHour" -Action $action -Trigger $trigger -RunLevel Highest -User "SYSTEM"
```

**Option B — NSSM** (Non-Sucking Service Manager) :
```powershell
winget install NSSM.NSSM
nssm install MappyHour "C:\tools\node-v20.18.0\node.exe" "C:\srv\mappy-hour\.next\standalone\server.js"
nssm set MappyHour AppEnvironmentExtra "NODE_ENV=production" "MAPPY_DATA_ROOT=C:\mappy-data" "MAPPY_FORCE_CACHE_ONLY=true" "PORT=3000"
nssm start MappyHour
```

---

## Prochaines étapes (par priorité)

1. **Décompression zstd** : après `git pull` sur mitch, lancer `mitch-install-zstd-native.ps1` pour télécharger le prebuilt `@mongodb-js/zstd`. Le fix `cwd=zstdDir` (commit ci-dessous) corrige l'URL incorrecte qui était générée.
2. **Valider** : ouvrir `https://mitch.tail63c42d.ts.net`, cliquer "daily", vérifier heatmap + terrasses lausannoise
3. **Persistance au reboot** — Task Scheduler ou NSSM
4. **(Futur) Places pour morges/vevey/genève** — créer les scripts `ingest:{region}:places` et les intégrer à `publish-atlas-release.ps1`

---

## Fichiers importants

| Fichier | Rôle |
|---------|------|
| `C:\srv\mappy-hour\` | Repo cloné |
| `C:\srv\mappy-hour\server.log` / `server.err` | Logs serveur |
| `C:\srv\mappy-hour\server.pid` | PID du process |
| `C:\mappy-data\cache\sunlight\` | Atlas (complet, 5 régions) |
| `C:\mappy-data\processed\places\` | Places OSM (lausanne + nyon) |
| `C:\tools\node-v20.18.0\` | Node.js portable |
| `C:\temp\mitch-start.ps1` | Script de démarrage (hors repo) |
| `scripts/headless-server-selfhosting/mitch-deploy.ps1` | Script de déploiement (dans le repo) |
| `scripts/headless-server-selfhosting/README.md` | Procédure complète |
| `scripts/release/publish-atlas-release.ps1` | Publication release atlas + places |
| `scripts/release/download-atlas.ts` | Download atlas + places depuis GitHub Release |
| `docs/architecture/shortcuts-registry.md` | Registre des optimisations |
