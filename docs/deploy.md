# Déploiement Mappy-Hour from scratch (Windows + WSL2 + Docker Engine + Tailscale Funnel)

Procédure reproductible pour déployer mappy-hour sur **n'importe quelle machine Windows 10/11**
(référence : `mitch`). Source de vérité unique pour le déploiement — les autres documents
(`docs/deployment/*`, `docs/deploy-handoff.md`, `scripts/headless-server-selfhosting/*`)
sont historiques ou des compléments topiques.

> Toutes les commandes sont **PowerShell admin** sauf indication contraire (`# bash WSL` = à
> lancer dans Ubuntu WSL2 en root).

---

## 0. Installation rapide via `mitch-bootstrap.ps1`

Pour une install fresh from-scratch, un script PowerShell idempotent automatise les phases
1 à 11 de ce guide. **Lis-le avant exécution** (cf. `scripts/deploy/README.md` pour les
détails). La suite manuelle (§1-§16) reste la référence pour ceux qui n'utilisent pas le
bootstrap, et pour comprendre / débugger ce qu'il fait.

**Prérequis depuis une machine avec navigateur** (one-time, hors machine cible) :

- Tailscale **OAuth client** (scopes `Devices > Core (Write)` + `Auth Keys (Write)`,
  tag `tag:ci`) — récupérer `client_id` et `client_secret`. Cf. §5.2.
- (Optionnel) Tailscale **API token** pour patcher l'ACL automatiquement (révoquer après).
- (Optionnel) GitHub **PAT** scope `repo` pour pousser les secrets GHA automatiquement.

**Sur la machine cible** (PowerShell admin) :

```powershell
iwr https://raw.githubusercontent.com/salfab/mappy-hour/master/scripts/deploy/mitch-bootstrap.ps1 -OutFile bootstrap.ps1
.\bootstrap.ps1 `
  -TailscaleOAuthClientId   <client-id> `
  -TailscaleOAuthSecret     <client-secret> `
  -TailscaleApiToken        <api-token>      `# optionnel
  -GitHubPat                <ghp-...>        `# optionnel
  -SshPublicKey             "ssh-ed25519 AAAA... github-actions-deploy"
```

Phases couvertes (idempotentes, skip si déjà fait) : features WSL2/VMP (reboot), git +
clone repo, kernel WSL + Ubuntu, `/etc/wsl.conf`, Docker Engine dans WSL, `.wslconfig`
kiosque, scheduled task `Mappy-WSL-Keepalive`, `sshd_config AllowUsers`, clé CI dans
`administrators_authorized_keys`, `.env` (`MAPPY_ATLAS_PATH`), dossier atlas vide, ACL
Tailscale via API, secrets GHA via `gh`, smoke test `docker compose up`.

State file : `C:\ProgramData\MappyHour\bootstrap-state.json` — re-run avec les mêmes args
après le reboot pour reprendre.

**Reste manuel après le script** :

- `tailscale up` (login interactif au premier run, en session kiosque)
- `tailscale serve --bg --https=443 http://localhost:3000` + `tailscale funnel --bg 3000` (§5.4)
- Peupler l'atlas dans `C:\mappy-data\cache\sunlight` (§7.3)
- Auto-login Windows pour `kiosque` (Settings ou Sysinternals Autologon)
- `MITCH_SSH_KEY` GHA secret (clé privée, push via web UI GitHub)

---

## 1. Architecture effective

```
Internet ──HTTPS:443──▶ <host>.<tailnet>.ts.net      (Tailscale Funnel, edge TLS)
                          │
                          ▼ HTTP loopback Windows
                       127.0.0.1:3000
                          │
                          ▼ NAT auto-forward WSL2 (lié à la session Windows)
            ┌─────────────────────────────────────────┐
            │ Session kiosque (auto-login)            │
            │ ┌─────────────────────────────────────┐ │
            │ │ WSL2 Ubuntu (user: root)            │ │
            │ │ ┌─────────────────────────────────┐ │ │
            │ │ │ container "mappy-hour"          │ │ │
            │ │ │ ghcr.io/salfab/mappy-hour:latest│ │ │
            │ │ └────────────┬────────────────────┘ │ │
            │ └──────────────│──────────────────────┘ │
            └────────────────│────────────────────────┘
                             │ bind-mount RO (9P)
                             ▼
                /mnt/c/mappy-data/cache/sunlight       (~30 GB, 5 régions)

GitHub Actions ──Tailscale OAuth──▶ ssh devops@<host> ──▶ powershell mitch-deploy-docker.ps1
        │                                                       │
        │                                                       ├── git pull
        │                                                       ├── wsl docker compose pull
        │                                                       └── wsl docker compose up -d
```

**Points-clés :**

- Le conteneur **n'écoute que sur loopback** (`127.0.0.1:3000`). Inaccessible si Funnel
  est coupé, jamais exposé sur le LAN ni sur l'IP tailnet.
- Tailscale Funnel termine TLS publiquement (cert auto-géré), pas de port-forwarding routeur.
- L'image GHCR est **publique** : pas de `docker login` requis en runtime.
- Le déploiement **doit tourner dans la session Windows `kiosque`** (auto-loggée), pas dans
  la session SSH `devops`. Justification : §3 « Pourquoi kiosque et pas devops ».

> **Raccourci atlas — bind-mount Windows (provisoire).** L'atlas (~30 GB) vit sur le
> filesystem Windows et est monté via 9P (`/mnt/c/mappy-data/...`). Recopier 30 GB dans un
> volume ext4 via 9P prend ~3h, et la stratégie atlas shardés (ADR-0024 / task #13) va
> changer le format — pas de raison d'optimiser tant que le format n'est pas figé. Cf.
> `docs/architecture/shortcuts-registry.md`.

---

## 2. Prérequis

| Requis | Détail |
|---|---|
| OS | Windows 10/11 (build récent, support WSL2). **Mirrored networking** demande Win11 22H2+ — sur Win10 22H2 (`10.0.19045.x`, cas de mitch) on reste en NAT default. |
| Comptes Windows | 2 comptes admin locaux : `devops` (clé SSH GitHub Actions) et `kiosque` (auto-login, propriétaire de la session Tailscale + WSL2). Création décrite §3. |
| Réseau | Sortie Internet directe (pas de proxy bloquant 443) |
| Tailnet | Compte avec droits d'ajouter un node et d'éditer la policy ACL |
| GitHub | Repo `salfab/mappy-hour` accessible en lecture (image GHCR publique) |

---

## 3. Comptes Windows et SSH — pourquoi kiosque ET devops

### 3.1 Pourquoi deux comptes

**WSL2 + port forwarding sont scoped par session utilisateur Windows.** Concrètement :
quand WSL2 démarre dans la session SSH de `devops`, le NAT qui mappe `127.0.0.1:3000` du
container vers le loopback Windows est **rattaché à cette session SSH**. À la fermeture de
la session SSH, la VM WSL2 est arrêtée et le mapping disparaît → Funnel reçoit du 502.

Solution : faire tourner Docker dans la session interactive **persistante** de la machine.
Sur mitch, c'est `kiosque` (auto-loggée au démarrage Windows, déjà propriétaire de
`tailscale-ipn` interactif depuis l'origine). `devops` reste utilisé exclusivement pour
SSH inbound (GitHub Actions) — il ne possède **aucune ressource WSL2**.

> **NE PAS** installer Ubuntu/Docker côté devops. La distro Ubuntu WSL2 dont devops
> dispose historiquement sur mitch (~8.85 GB, task #15) doit être supprimée.

### 3.2 SSH `AllowUsers` — autoriser kiosque

Le `sshd_config` par défaut sur mitch restreint l'accès SSH à `AllowUsers devops`. Pour que
GitHub Actions puisse pousser des opérations qui exécutent **dans la session kiosque**, il
faut soit (a) ouvrir SSH à `kiosque` et déléguer (b) garder devops SSH et utiliser un
mécanisme de bascule de session (Task Scheduler triggé par devops).

Recommandation actuelle : ouvrir aussi `kiosque` en SSH, et que le script de déploiement
SSH-as-kiosque appelle directement `wsl docker compose ...`.

```powershell
# Backup avant édition
Copy-Item C:\ProgramData\ssh\sshd_config C:\ProgramData\ssh\sshd_config.bak

# Éditer C:\ProgramData\ssh\sshd_config :
#   AllowUsers devops kiosque
notepad C:\ProgramData\ssh\sshd_config

# Valider la syntaxe AVANT de restart (un sshd_config invalide bloque tout SSH)
& "C:\Windows\System32\OpenSSH\sshd.exe" -t -f C:\ProgramData\ssh\sshd_config
# Exit code 0 = OK. Sinon, restaurer le backup et corriger.

# Appliquer
Restart-Service sshd
```

La clé `github-actions-deploy` est déjà dans `C:\ProgramData\ssh\administrators_authorized_keys`
(authorized keys partagées pour tous les admins Windows). Comme `devops` et `kiosque` sont
tous deux admins, la même clé permet de se connecter aux deux comptes une fois
`AllowUsers` ouvert.

### 3.3 Hardening compte deploy non-admin

`devops` et `kiosque` sont actuellement admins. Durcissement futur : créer un compte
`mappy-deploy` non-admin avec droits restreints sur `C:\srv\mappy-hour` uniquement.
Non bloquant à ce stade.

---

## 4. Persistance WSL2 — les 3 conditions nécessaires

Sans ces trois conditions, **la VM WSL2 cycle toutes les ~50 secondes** (idle timeout
silencieux du VM Plan9 socket). Symptôme côté container : `dmesg` montre :

```
Operation canceled @p9io.cpp:258 (AcceptAsync)
Received SIGTERM from PID 1 (systemd-shutdow)
```

Et le client Funnel reçoit 502 / Connection refused intermittents. **Les trois conditions
sont cumulatives**, aucune n'est optionnelle.

### 4.1 `/etc/wsl.conf` dans la distro

```powershell
# Depuis n'importe quelle session admin (l'écriture passe par wsl.exe)
wsl -d Ubuntu -u root -e bash -c 'cat > /etc/wsl.conf <<EOF
[boot]
command = service docker start
systemd = true

[user]
default = root
EOF'

wsl --shutdown   # recharger pour appliquer wsl.conf
```

`systemd=true` permet à Docker d'utiliser cgroups v2 ; `default=root` évite `sudo` côté
hôte ; `command=service docker start` redémarre Docker au boot WSL.

### 4.2 `.wslconfig` côté **profil kiosque**

Le `.wslconfig` est lu **dans le profil de l'utilisateur Windows qui lance WSL**. Comme
on tourne Docker côté kiosque, c'est `C:\Users\kiosque\.wslconfig` (pas devops) :

```powershell
# À exécuter en session kiosque (ou via SSH-as-kiosque si AllowUsers ouvert)
@"
[wsl2]
vmIdleTimeout=-1
"@ | Set-Content C:\Users\kiosque\.wslconfig -Encoding UTF8
```

`vmIdleTimeout=-1` désactive l'arrêt automatique du VM après inactivité… mais Windows
considère « inactivité » comme **absence d'invocation `wsl.exe` côté utilisateur**, pas
absence de process dans le VM. D'où la 3e condition ci-dessous.

### 4.3 Scheduled task au logon kiosque — `sleep infinity`

Sans ce keepalive, même avec `vmIdleTimeout=-1`, la VM s'arrête ~50s après le dernier
`wsl.exe`. La tâche planifiée maintient une invocation utilisateur active en permanence.

```powershell
# À exécuter en session kiosque (sinon -User "kiosque" demande le mot de passe)
$action = New-ScheduledTaskAction `
    -Execute "wsl.exe" `
    -Argument "-d Ubuntu -u root --exec /usr/bin/sleep infinity"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "kiosque"
$principal = New-ScheduledTaskPrincipal -UserId "kiosque" -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask -TaskName "WslKeepalive" `
    -Action $action -Trigger $trigger -Principal $principal -Settings $settings
```

Vérifier après reboot :

```powershell
Get-ScheduledTask -TaskName WslKeepalive | Get-ScheduledTaskInfo
# LastTaskResult attendu : 267009 ("Currently running") tant que la session kiosque est active
```

---

## 5. Tailscale — node, ACL, OAuth CI

### 5.1 Installer et joindre le tailnet

```powershell
winget install -e --id Tailscale.Tailscale
# Lancer la GUI une fois en session kiosque, login avec le compte tailnet.
# Tailscale démarre en SYSTEM mais sa config "serve/funnel" appartient à la session
# utilisateur — d'où l'importance de faire le login dans kiosque.
tailscale status
```

Dans `https://login.tailscale.com/admin/` :

1. **DNS → "HTTPS Certificates" : ON** (requis pour les certs Funnel).
2. **Access controls** — ajouter au policy file :
   ```jsonc
   {
     "nodeAttrs": [
       { "target": ["<hostname>"], "attr": ["funnel"] }
     ]
   }
   ```
   `<hostname>` = nom du node (ex. `mitch`).
3. Vérifier sur la machine :
   ```powershell
   tailscale cert "$(tailscale status --json | ConvertFrom-Json | % { $_.Self.DNSName.TrimEnd('.') })"
   ```
   Doit produire `.crt` + `.key` sans erreur.

### 5.2 OAuth client pour GitHub Actions

Le workflow `.github/workflows/deploy-mitch.yml` rejoint le tailnet via OAuth (pas
d'authkey à rotater).

**ACL — déclarer `tag:ci` dans `tagOwners` :**

```jsonc
{
  "tagOwners": {
    "tag:ci": ["autogroup:admin"]
  }
}
```

Méthode scriptée et idempotente (recommandé) :

```bash
# bash WSL ou Linux
# Générer un API token (scope "all") :
#   https://login.tailscale.com/admin/settings/keys
TS_API_TOKEN=tskey-api-... scripts/deploy/setup-tailscale-ci-acl.sh
# Tailnet auto-détecté via `tailscale status --json`. Révoquer le token après usage.
```

**Créer le client OAuth :**

1. Tailscale admin → **Settings → OAuth clients → Generate client**.
2. **Scopes — les deux sont requis** :
   - **Devices → Core (Write)** : permet à l'OAuth client de gérer les devices.
   - **Auth Keys (Write)** : permet à l'OAuth client de **créer** des auth keys éphémères au démarrage de la GHA. Sans ce scope, `tailscale up` échoue avec `Status: 403, calling actor does not have enough permissions to perform this function` même si Devices:Core est coché.
3. **Tags** : ajouter `tag:ci` dans le champ Tags (doit aussi exister dans `tagOwners`, cf. au-dessus).
4. Copier `client_id` et `client_secret`.

### 5.3 Secrets GitHub Actions

`Repo → Settings → Secrets and variables → Actions` :

| Secret | Valeur |
|--------|--------|
| `TS_OAUTH_CLIENT_ID` | client ID OAuth Tailscale |
| `TS_OAUTH_CLIENT_SECRET` | client secret OAuth Tailscale |
| `MITCH_SSH_KEY` | clé privée SSH ed25519 (couplée à la clé publique présente dans `administrators_authorized_keys` sur mitch) |
| `MITCH_SSH_HOST` | `mitch` (MagicDNS Tailscale) |
| `MITCH_SSH_USER` | `kiosque` (cible : pas `devops` — voir §3 et §10) |
| `MITCH_KNOWN_HOSTS` | sortie de `ssh-keyscan mitch` (pin host key) |

L'ancien `TS_AUTHKEY` (authkey éphémère) peut rester en standby pour rollback, à
supprimer après quelques cycles GHA verts en OAuth.

### 5.4 Brancher Tailscale Funnel

**Depuis la session interactive kiosque** (en RDP ou en physique — pas via SSH-as-devops) :

```powershell
tailscale serve --bg --https=443 http://127.0.0.1:3000
tailscale funnel --bg 3000
tailscale serve status
tailscale funnel status
```

L'URL publique apparaît dans `tailscale funnel status` : `https://<hostname>.<tailnet>.ts.net/`.

La config Funnel est persistée par le daemon Tailscale et survit aux reboots tant que
Tailscale démarre.

---

## 6. WSL2 + Ubuntu + Docker Engine (côté kiosque)

> Toutes les commandes ci-dessous sont à exécuter **dans la session kiosque** (RDP,
> physique, ou SSH-as-kiosque après §3.2).
>
> **Pas Docker Desktop.** Docker Desktop demande une session interactive et une licence pro
> pour usage commercial. On utilise Docker Engine directement dans Ubuntu WSL2.

### 6.1 WSL2 + Ubuntu

```powershell
wsl --install -d Ubuntu --web-download
# >>> redémarrer si demandé <<<
```

Au premier lancement, créer un user local (peu importe — on tournera en root).
Appliquer le `/etc/wsl.conf` documenté en §4.1.

### 6.2 Docker Engine dans Ubuntu

```powershell
wsl -d Ubuntu -u root -e bash -c '
set -e
apt-get update
apt-get install -y ca-certificates curl gnupg lsb-release
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
service docker start
'
```

Sanity check :

```powershell
wsl -d Ubuntu -u root -e bash -c 'docker version && docker run --rm hello-world'
```

### 6.3 Git côté Windows

```powershell
winget install -e --id Git.Git
```

---

## 7. Repo, `.env`, atlas

### 7.1 Cloner le repo

```powershell
New-Item -ItemType Directory -Force C:\srv | Out-Null
git clone https://github.com/salfab/mappy-hour.git C:\srv\mappy-hour
```

WSL lira le compose via `/mnt/c/srv/mappy-hour/docker-compose.yml`.

### 7.2 `.env` — bind-mount Windows

Trois bind-mounts sont nécessaires (depuis la release `v9.2.20260512xxx`) :
- `MAPPY_ATLAS_PATH` → cache atlas sunlight (~10-30 GB)
- `MAPPY_BUILDINGS_PATH` → global obstacle index `lausanne-buildings-index.json` (~70 MB)
- `MAPPY_PLACES_PATH` → sidecars `<region>-places.json` (~100 KB) — **sans ça, l'overlay terrasses est vide**

```powershell
@"
MAPPY_ATLAS_PATH=/mnt/c/mappy-data/cache/sunlight
MAPPY_BUILDINGS_PATH=/mnt/c/mappy-data/processed/buildings
MAPPY_PLACES_PATH=/mnt/c/mappy-data/processed/places
"@ | Set-Content C:\srv\mappy-hour\.env -Encoding UTF8

New-Item -ItemType Directory -Force C:\mappy-data\cache\sunlight | Out-Null
New-Item -ItemType Directory -Force C:\mappy-data\processed\buildings | Out-Null
New-Item -ItemType Directory -Force C:\mappy-data\processed\places | Out-Null
```

> **Pourquoi 3 bind-mounts ?** L'image Docker est immuable et ne contient ni
> le global buildings index (trop volumineux), ni les places sidecars
> (`data/processed/` est gitignored, jamais bake). Sans bind-mount places,
> `loadAllPlaces()` retourne null et le timeline stream n'émet jamais d'event
> `places` → overlay terrasses vide côté UI. Cf. ADR-0024 / commit du
> 2026-05-12.

Autres variables (`MAPPY_FORCE_CACHE_ONLY=true`, `MAPPY_DATA_ROOT=/data`,
`NODE_ENV=production`) sont déjà fixées dans `docker-compose.yml` — l'image est immuable
quel que soit l'environnement, seuls les chemins host varient.

### 7.3 Peupler l'atlas

**Option A — robocopy depuis lappymaclapface (LAN, rapide) :**

```powershell
robocopy "D:\mappy-hour-data\cache\sunlight" "\\mitch\C$\mappy-data\cache\sunlight" /MIR /MT:8
```

**Option B — via le service `atlas-loader` (profil `loader`) :**

```powershell
# Cache-only minimum (Mitch typique) — atlas + places seulement
wsl -d Ubuntu -u root -e bash -c '
cd /mnt/c/srv/mappy-hour
docker compose --profile loader run --rm atlas-loader \
  --repo=salfab/mappy-hour \
  --regions=lausanne,nyon,morges,vevey,vevey_city,geneve
'

# Si l'hôte doit aussi pouvoir re-précomputer (NUC GPU plus tard) :
# ajouter --with-grid-metadata --with-buildings à la fin de la command
```

Vérifier :

```powershell
Get-ChildItem C:\mappy-data\cache\sunlight -Recurse -Filter "*.idx" | Measure-Object
```

---

## 7bis. Lifecycle des releases atlas

Une release sur GitHub est composée de plusieurs archives indépendantes
(décidé 2026-05-12 pour minimiser le téléchargement sur Mitch) :

| Archive | Contenu | Requis pour |
|---|---|---|
| `<region>-atlas.tar` | Shards atlas zstd-10 + `.atlas.idx` | **Toutes** les régions servies |
| `<region>-grid-metadata.tar` | Indoor/outdoor masks + élévations par tuile | Re-précompute uniquement |
| `buildings-shared.tar` | Global `lausanne-buildings-index.json` (~70 MB) | Re-précompute uniquement |
| `<region>-places.json` | Sidecar OSM places | Lausanne, Nyon uniquement |
| `release-manifest.json` | sha256s + hashes + tile counts | Toujours téléchargé en premier |

Naming : `vMAJOR.MINOR.YYYYMMDDNNN` — auto-généré par `publish-atlas-release.ps1`
en scrutant les tags du jour et incrémentant le compteur `NNN` (000-999).

### Refresh atlas Mitch — workflow_dispatch

GitHub Actions → **Refresh atlas on Mitch** → Run workflow.

Inputs :
- `release` (default `latest`) — tag spécifique ou `latest`
- `with_grid_metadata` (default `false`) — pour Mitch headless : laisser `false`
- `with_buildings` (default `false`) — idem, `false` sauf si re-précompute prévu
- `regions` (default vide = toutes celles du manifest)

Idempotency : `download-atlas.ts` skip per-region si `<region>/<modelVersionHash>/g1/atlas/r0.75/`
sur disque contient déjà tous les fichiers attendus. Même hash → no-op. Hash différent
(ex. ingest buildings refait) → nouveau dossier, download obligatoire.

Le workflow restart `mappy-hour` après le téléchargement pour que le runtime
re-scan les hashes disponibles (`findCachedModelVersionHash`).

> ⚠️ **Pic disque temporaire pendant le download** ≈ 1.5× la taille du plus
> gros tar (download tmp + extracted). `download-atlas.ts` nettoie au fur et à
> mesure (per-archive `unlink` puis `rm -rf` du staging dir).

---

## 8. Démarrer le service

```powershell
wsl -d Ubuntu -u root -e bash -c 'cd /mnt/c/srv/mappy-hour && docker compose pull && docker compose up -d'
wsl -d Ubuntu -u root -e bash -c 'docker ps --filter name=mappy-hour'
wsl -d Ubuntu -u root -e bash -c 'docker logs -f mappy-hour'   # Ctrl-C pour quitter
```

Smoke test local :

```powershell
Invoke-WebRequest http://127.0.0.1:3000/api/datasets -UseBasicParsing | Select-Object StatusCode
# Attendu : 200
```

---

## 9. Validation end-to-end

```powershell
# 1. Loopback Windows
Invoke-WebRequest http://127.0.0.1:3000/api/datasets -UseBasicParsing | Select-Object StatusCode

# 2. Tailnet (depuis un autre node)
$dns = tailscale status --json | ConvertFrom-Json | % { $_.Self.DNSName.TrimEnd('.') }
curl "https://$dns/api/datasets"

# 3. Externe — téléphone en 4G : ouvrir l'URL Funnel, la carte Leaflet doit charger.

# 4. Isolation — depuis un autre node tailnet, port direct (DOIT échouer)
curl http://<tailnet-ip-de-ce-node>:3000   # attendu : timeout / refusé

# 5. Headers de sécurité publics
curl -I "https://$dns/"
# Attendu : Strict-Transport-Security, X-Content-Type-Options: nosniff,
#           X-Frame-Options: DENY, Referrer-Policy: strict-origin-when-cross-origin

# 6. Container healthy
wsl -d Ubuntu -u root -e bash -c "docker inspect mappy-hour --format '{{json .State.Health}}'"
```

---

## 10. CI/CD — GitHub Actions

### 10.1 État actuel

Workflow `.github/workflows/deploy-mitch.yml` :

- **Trigger** : `push: branches: [master]` + `workflow_dispatch`
- **Tailscale** : OAuth via `tailscale/github-action@v3` (tag `tag:ci`)
- **SSH** : via `webfactory/ssh-agent` + clé `MITCH_SSH_KEY` + host key pinned
- **Cible SSH** : `kiosque@<host>` (secret `MITCH_SSH_USER=kiosque`, `MITCH_SSH_HOST` = hostname tailnet)
- **Bootstrap inline** : `git pull --ff-only` exécuté directement depuis SSH (avant
  d'invoquer le script du repo), pour éviter le chicken-and-egg quand le script n'est pas
  encore checkout sur la cible.
- **Script lancé** : `mitch-deploy-docker.ps1` (git pull + docker compose pull + up
  + healthcheck loopback HTTP 200).

### 10.2 Déclenchement manuel

```powershell
ssh kiosque@mitch "powershell -File C:\srv\mappy-hour\scripts\headless-server-selfhosting\mitch-deploy-docker.ps1"
```

Le script fait :

1. `git pull` dans `C:\srv\mappy-hour`
2. `wsl docker compose pull` (image GHCR fraîche)
3. `wsl docker compose up -d --remove-orphans`
4. Sleep 25s, puis health check `http://127.0.0.1:3000/api/datasets`
5. Si fail : dump `docker logs mappy-hour --tail 30` et exit 1

L'image étant rebuilée à chaque push master par `.github/workflows/docker-publish.yml`,
le pull suffit — pas de build local.

---

## 11. Hardening — état actuel et trade-offs

### 11.1 Actif

- [x] Bind `127.0.0.1:3000` sur l'hôte (jamais `0.0.0.0`) — défini dans `docker-compose.yml`.
- [x] Volume atlas monté en **read-only** côté container.
- [x] Headers Next.js : `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`,
      `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`,
      `poweredByHeader: false` — voir `next.config.ts`.
- [x] ACL Tailscale : attribut `funnel` limité au seul node concerné.
- [x] `tag:ci` : nœuds éphémères, expirent à la fin du job GHA.
- [x] Isolation WSL2 (VM séparée) + Tailscale Funnel (pas d'expo directe LAN/WAN).

### 11.2 Restauré

Le `docker-compose.yml` applique maintenant le hardening du plan initial :

```yaml
cap_drop: [ALL]
security_opt: [no-new-privileges:true]
read_only: true
tmpfs: [/tmp]
```

Confirmé sur 120s+ avec l'image courante : Next.js 16 démarre et reste healthy,
le healthcheck `node -e ... GET /api/datasets` passe. Le crashloop `ELIFECYCLE
Command failed` observé pendant la mise en place initiale n'a pas été reproduit
après rebuild — il semble lié à une instabilité transitoire (probablement
pression disque pendant l'install kiosque ou cycles de la VM WSL2 d'avant
l'activation systemd) plutôt qu'à un manque de capability.

### 11.3 Reste à durcir

- [ ] **`user: node` (UID non-root)** — seul gap restant côté container. Avec
      `read_only` + `tmpfs /home/node`, le tmpfs est monté `root:root` par
      défaut et `node` (UID 1000) ne peut pas y écrire ; corepack échoue avec :

      ```
      errno: -13, code: 'EACCES', syscall: 'mkdir',
      path: '/home/node/.cache/node/corepack/v1'
      ```

      Pistes (à benchmarker) :
      - `tmpfs /home/node:uid=1000,gid=1000` dans le compose (le plus simple).
      - `ENV COREPACK_HOME=/tmp/corepack` dans le Dockerfile — le tmpfs `/tmp`
        existe déjà, pas besoin d'un second tmpfs.
      - Pré-créer `/home/node/.cache` dans le Dockerfile + monter un volume
        scratch dédié (plus lourd, à éviter si une des deux options
        ci-dessus suffit).

      Pas urgent : le hardening en place (cap_drop ALL + no-new-privileges +
      read_only + isolation WSL2 + Funnel + bind loopback) est déjà très solide.
- [ ] Compte deploy non-admin sur Windows (devops/kiosque sont admins, cf. §3.3).
- [ ] Vérifier qu'aucun port-forwarding routeur ne contourne Funnel.
- [ ] Windows Update + Tailscale auto-update activés.
- [ ] Documenter le tag atlas en cours d'usage pour rollback.

---

## 12. Diagnostic — symptômes courants

### 12.1 `https://...ts.net/` → 502/503 Funnel

Cycle de check du moins coûteux au plus coûteux :

```powershell
# 1. Funnel actif ?
tailscale funnel status
tailscale serve status

# 2. Container UP côté WSL ?
wsl -d Ubuntu -u root -e bash -c "docker ps --filter name=mappy-hour"

# 3. Port 3000 ouvert côté Windows ?
Test-NetConnection -ComputerName 127.0.0.1 -Port 3000

# 4. Si Test-NetConnection échoue : WSL2 vivant ?
wsl -d Ubuntu -u root -e bash -c "uptime"
# Si la commande prend > 5s, la VM redémarre → suspect §4 (persistance WSL2)

# 5. Logs container
wsl -d Ubuntu -u root -e bash -c "docker logs mappy-hour --tail 50"

# 6. dmesg côté WSL — chercher les cycles VM
wsl -d Ubuntu -u root -e bash -c "dmesg | grep -E 'p9io|SIGTERM|systemd-shutdow' | tail -20"
# Présence de "Operation canceled @p9io.cpp:258" = la VM cycle → §4
```

### 12.2 Cycles WSL2 (`p9io` dans dmesg)

Symptôme : 502 intermittents, `docker ps` parfois OK parfois "Cannot connect to the Docker
daemon", et `dmesg | grep p9io` montre :

```
[NNN.NNN] Operation canceled @p9io.cpp:258 (AcceptAsync)
[NNN.NNN] Received SIGTERM from PID 1 (systemd-shutdow)
```

Cause : une des 3 conditions de §4 manque. Diagnostic :

```powershell
# Condition (a) - wsl.conf
wsl -d Ubuntu -u root -e cat /etc/wsl.conf

# Condition (b) - .wslconfig kiosque
Get-Content C:\Users\kiosque\.wslconfig

# Condition (c) - scheduled task
Get-ScheduledTask -TaskName WslKeepalive | Get-ScheduledTaskInfo
# LastTaskResult attendu : 267009 (currently running) ; sinon, tâche absente ou
# session kiosque déconnectée
```

### 12.3 GitHub Actions échoue

| Erreur | Cause | Action |
|---|---|---|
| `Error: requested tag "tag:ci" is invalid` (Tailscale step) | `tag:ci` pas dans `tagOwners` ACL ou pas coché dans l'OAuth client | §5.2, relancer `setup-tailscale-ci-acl.sh` |
| `Permission denied (publickey)` côté ssh | Clé `MITCH_SSH_KEY` ne matche pas `administrators_authorized_keys` côté mitch | Régénérer la paire de clés, repush le secret |
| `Could not resolve hostname mitch` | Tailscale n'a pas créé le node éphémère, ou MagicDNS off | Vérifier l'output de l'étape "Setup Tailscale" |
| `git pull failed` côté script | Le repo `C:\srv\mappy-hour` est dans un état dirty | SSH manuel + `git status` + nettoyer |
| Healthcheck final HTTP != 200 | Container crashloop | Dump `docker logs mappy-hour --tail 100` |

### 12.4 Cache miss runtime / 503 sur API sunlight

```powershell
# Le bind-mount est-il bien populé ?
wsl -d Ubuntu -u root -e bash -c "docker exec mappy-hour ls /data/cache/sunlight"
# Doit lister lausanne/, nyon/, morges/, vevey/, vevey_city/, geneve/

# .env côté hôte ?
Get-Content C:\srv\mappy-hour\.env
# Doit contenir MAPPY_ATLAS_PATH=/mnt/c/mappy-data/cache/sunlight

# Atlas populé côté Windows ?
Get-ChildItem C:\mappy-data\cache\sunlight -Recurse -Filter "*.idx" | Measure-Object
```

### 12.5 Funnel cert échoue

```powershell
tailscale cert <hostname>.<tailnet>.ts.net
# Si erreur : DNS → "HTTPS Certificates" off dans l'admin Tailscale → §5.1
```

---

## 13. Maintenance

### 13.1 Mise à jour code (= push master)

Le workflow GHA se déclenche automatiquement. Pour pousser manuellement :

```powershell
ssh kiosque@mitch "powershell -File C:\srv\mappy-hour\scripts\headless-server-selfhosting\mitch-deploy-docker.ps1"
```

### 13.2 Mise à jour atlas

```powershell
# Option A : robocopy depuis lappymaclapface (LAN)
robocopy "D:\mappy-hour-data\cache\sunlight" "\\mitch\C$\mappy-data\cache\sunlight" /MIR /MT:8

# Option B : atlas-loader
wsl -d Ubuntu -u root -e bash -c '
cd /mnt/c/srv/mappy-hour
docker compose --profile loader run --rm atlas-loader \
  --repo=salfab/mappy-hour \
  --regions=lausanne,nyon,morges,vevey,vevey_city,geneve
'

# Restart pour rafraîchir le cache mémoire
wsl -d Ubuntu -u root -e bash -c "cd /mnt/c/srv/mappy-hour && docker compose restart mappy-hour"
```

### 13.3 Logs / debug

```powershell
wsl -d Ubuntu -u root -e bash -c "docker logs -f mappy-hour"
wsl -d Ubuntu -u root -e bash -c "docker inspect mappy-hour --format '{{json .State}}'"
tailscale serve status
tailscale funnel status
```

### 13.4 Arrêt / redémarrage

```powershell
wsl -d Ubuntu -u root -e bash -c "cd /mnt/c/srv/mappy-hour && docker compose down"
wsl -d Ubuntu -u root -e bash -c "cd /mnt/c/srv/mappy-hour && docker compose up -d"

tailscale funnel 443 off    # coupe l'expo publique, service local reste up
tailscale serve reset       # nettoie tout serve+funnel
```

---

## 14. Gestion de l'espace disque

mitch a un disque C: d'environ **118 GB**. Inventaire approximatif :

| Emplacement | Taille | Note |
|---|---|---|
| `C:\mappy-data\cache\sunlight\` | ~30 GB | Atlas 5 régions — **load-bearing**, ne pas toucher |
| `C:\Users\kiosque\AppData\Local\Plex Media Server` | ~20 GB | Metadata + thumbnails Plex (pas les médias). Anciens `library.db-YYYY-MM-DD` peuvent être supprimés, Plex recrée |
| Distro Ubuntu WSL kiosque | ~8 GB | Là où tourne Docker — **load-bearing** |
| Distro Ubuntu WSL devops | ~8.85 GB | **Obsolète** (cf. §3) — à supprimer (task #15) : `wsl --unregister Ubuntu` en session devops |
| `C:\srv\mappy-hour` | < 1 GB | Repo (sans node_modules — le build vit dans le conteneur) |
| Windows + Tailscale + reste | reste | |

### 14.1 Commandes utiles

```powershell
# Espace dispo C:
Get-PSDrive C | Select-Object Used,Free

# Taille des distros WSL (depuis n'importe quelle session)
Get-ChildItem "$env:LOCALAPPDATA\Packages" -Recurse -Include "ext4.vhdx" |
    Select-Object FullName, @{N="GB";E={[math]::Round($_.Length / 1GB, 2)}}

# Nettoyage Plex DB backups
Get-ChildItem "C:\Users\kiosque\AppData\Local\Plex Media Server\Plug-in Support\Databases" `
    -Filter "library.db-2*" | Remove-Item -Force

# Docker — espace consommé par images/volumes/build cache
wsl -d Ubuntu -u root -e bash -c "docker system df"
wsl -d Ubuntu -u root -e bash -c "docker system prune -af"   # purge images dangling + cache
```

---

## 15. Pattern opérationnel — `scp` plutôt que PowerShell inline

Les commandes PowerShell passées **en ligne** via SSH (`ssh kiosque@mitch "powershell -Command \"...\""`)
se font régulièrement déchirer par le parseur de l'un des deux côtés :

- Em dash, guillemets typographiques (copy-paste depuis un éditeur) mal échappés.
- `$_` interprété par le shell local au lieu de PowerShell distant.
- `&&` pas supporté par PowerShell 5.1 (cas mitch — PS Core dispo, mais pas par défaut).
- Caractères accentués mangés par le pipe SSH si la console n'est pas UTF-8.

**Pattern fiable :**

```powershell
# Local
$script = @'
# script PowerShell ici, multi-ligne, sans souci d'échappement
Get-Service sshd
'@
$script | Set-Content C:\temp\foo.ps1 -Encoding UTF8

# Push + exec
scp C:\temp\foo.ps1 kiosque@mitch:C:/temp/foo.ps1
ssh kiosque@mitch "powershell -NoProfile -ExecutionPolicy Bypass -File C:\temp\foo.ps1"
```

Vaut pour tout script > 5 lignes ou contenant des caractères spéciaux. Les scripts
récurrents vivent directement dans le repo sous `scripts/headless-server-selfhosting/`.

---

## 16. Voir aussi

- `docs/deployment/environment-config.md` — variables d'env (`MAPPY_*`) en détail
- `docs/deployment/server-setup.md` — déploiement Node.js natif via systemd (**legacy**,
  non utilisé sur mitch ; conservé pour Linux nu sans Docker)
- `docs/deploy-handoff.md` — historique du déploiement initial Node.js natif (mai 2026,
  pré-bascule Docker)
- `scripts/headless-server-selfhosting/README.md` — bootstrap initial SSH + Tailscale du
  serveur headless
- `scripts/headless-server-selfhosting/deploy-notes.md` — notes d'archi (bind-mount,
  scripts en place)
- `docs/architecture/adr-0024-atlas-sharding-cache-only-runtime.md` — migration prévue
  bind-mount → volume
- `docs/architecture/shortcuts-registry.md` — registre des raccourcis et conditions
  d'invalidité
