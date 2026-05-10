# Handoff — Déploiement mappy-hour sur mitch

> Dernière mise à jour : 2026-05-10  
> Session origine : Claude Sonnet 4.6 (plan `tidy-cuddling-feather.md`)

---

## État actuel

| Composant | État |
|-----------|------|
| App Next.js buildée sur mitch | ✅ Build réussi |
| Serveur en cours d'exécution | ✅ WMI, survit aux déconnexions SSH |
| Tailscale Funnel (HTTPS public) | ✅ `https://mitch.tail63c42d.ts.net` |
| Atlas (5 régions) | ✅ Complet — lausanne 877t, nyon 14t, morges 28t, vevey 88t, geneve 463t |
| Places OSM (terrasses) | ❌ **À faire** — ingest non lancé |
| API sunlight/daily | ❌ **À corriger** — 3 fixes en attente de déploiement sur mitch |
| Persistance au reboot | ❌ Non configuré (process WMI, mais pas de scheduled task) |

---

## App sur mitch — détails techniques

- **Runtime** : Node.js v20.18.0 portable → `C:\tools\node-v20.18.0`
- **pnpm** : 9.0.6 → `%APPDATA%\npm`
- **Repo** : `C:\srv\mappy-hour` (branch `master`)
- **Data root** : `C:\mappy-data` (`MAPPY_DATA_ROOT=C:\mappy-data`)
- **Atlas** : `C:\mappy-data\cache\sunlight\{region}\{hash}\g1\atlas\r0.75\`
- **Places** : `C:\mappy-data\processed\places\` — **vide, ingest à lancer**
- **Build flag** : `NEXT_PUBLIC_FORCE_CACHE_ONLY=true`
- **Port** : 3000, bind `0.0.0.0`
- **Logs** : `C:\srv\mappy-hour\server.log` / `server.err`
- **PID** : `C:\srv\mappy-hour\server.pid`
- **Script de démarrage** : `C:\temp\mitch-start.ps1`

---

## Déployer une mise à jour (commande unique)

```powershell
ssh devops@mitch "powershell -File C:\srv\mappy-hour\scripts\headless-server-selfhosting\mitch-deploy.ps1"
```

Le script fait : `git pull` → `pnpm install` → `pnpm build` (~3 min) → kill + redémarrage WMI.

---

## Actions immédiates à faire

### 1. Push les commits en attente (depuis lappymaclapface)

Deux commits locaux attendent d'être poussés :

```
bedce17  fix(ui+cache): default mode daily, detect atlas-only hashes, add vevey to regions
f402acd  docs(deploy): add mitch-deploy.ps1 and README section for update workflow
```

```powershell
git push origin master
```

### 2. Déployer sur mitch

```powershell
ssh devops@mitch "powershell -File C:\srv\mappy-hour\scripts\headless-server-selfhosting\mitch-deploy.ps1"
```

Ce déploiement corrige 3 bugs :
- **Mode par défaut** "daily" au lieu de "instant" dans l'UI
- **"No tiles found"** — `findCachedModelVersionHash` détectait uniquement la structure `m15/{date}`, ignorant les fichiers atlas `atlas/r0.75/*.atlas.bin.gz`. Les requêtes retournaient toujours 0 candidats.
- **Vevey absent** de `PRECOMPUTED_REGIONS` → zone non reconnue

### 3. Lancer l'ingest des places (sur mitch, après le déploiement)

```powershell
ssh devops@mitch
# puis sur mitch :
$env:PATH = "C:\tools\node-v20.18.0;$env:APPDATA\npm;" + $env:PATH
Set-Location C:\srv\mappy-hour
$env:MAPPY_DATA_ROOT = "C:\mappy-data"
pnpm ingest:lausanne:places
pnpm ingest:nyon:places
```

Les fichiers produits :
- `C:\mappy-data\processed\places\lausanne-places.json`
- `C:\mappy-data\processed\places\nyon-places.json`

Pas besoin de redémarrer le serveur — les places sont chargées à la demande.

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
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -File C:\temp\start-wmi.ps1"
$trigger = New-ScheduledTaskTrigger -AtStartup
Register-ScheduledTask -TaskName "MappyHour" -Action $action -Trigger $trigger -RunLevel Highest -User "SYSTEM"
```

**Option B — NSSM** (Non-Sucking Service Manager) :
```powershell
winget install NSSM.NSSM
nssm install MappyHour "C:\tools\node-v20.18.0\node.exe" "C:\srv\mappy-hour\.next\standalone\server.js"
nssm set MappyHour AppEnvironmentExtra "NODE_ENV=production" "MAPPY_DATA_ROOT=C:\mappy-data" "NEXT_PUBLIC_FORCE_CACHE_ONLY=true" "PORT=3000"
nssm start MappyHour
```

---

## Prochaines étapes (par priorité)

1. **Push + déployer** les 3 fixes (commandes ci-dessus, §Actions immédiates)
2. **Ingest places** (terrasses Lausanne + Nyon)
3. **Valider** : ouvrir `https://mitch.tail63c42d.ts.net`, cliquer "daily", vérifier qu'une zone couverte affiche des résultats
4. **Persistance au reboot** — Task Scheduler ou NSSM
5. **(Futur) Docker** — image = code + places baked in, volume = atlas. `docker compose pull && up` pour déployer.

---

## Fichiers importants

| Fichier | Rôle |
|---------|------|
| `C:\srv\mappy-hour\` | Repo cloné |
| `C:\srv\mappy-hour\server.log` / `server.err` | Logs serveur |
| `C:\srv\mappy-hour\server.pid` | PID du process |
| `C:\mappy-data\cache\sunlight\` | Atlas (complet) |
| `C:\mappy-data\processed\places\` | Places OSM (vide, à ingester) |
| `C:\tools\node-v20.18.0\` | Node.js portable |
| `C:\temp\mitch-start.ps1` | Script de démarrage (hors repo) |
| `scripts/headless-server-selfhosting/mitch-deploy.ps1` | Script de déploiement (dans le repo) |
| `scripts/headless-server-selfhosting/README.md` | Procédure complète |
| `docs/architecture/shortcuts-registry.md` | Registre des optimisations |
