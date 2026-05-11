# Déploiement Mappy-Hour from scratch (Windows + WSL2 + Docker Engine + Tailscale Funnel)

Procédure reproductible pour déployer mappy-hour sur **n'importe quelle machine Windows 10/11**
(référence : `mitch`). Source de vérité unique pour le déploiement — les autres documents
(`docs/deployment/*`, `docs/deploy-handoff.md`, `scripts/headless-server-selfhosting/*`)
sont historiques ou des compléments topiques.

> Toutes les commandes sont **PowerShell admin** sauf indication contraire (`# bash WSL` = à
> lancer dans Ubuntu WSL2 en root).

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
2. **Scope** : **Devices → Core (Write)** — coche `devices:write`.
3. **Tags** : cocher `tag:ci` (doit aussi exister dans `tagOwners`, cf. au-dessus).
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

```powershell
@"
MAPPY_ATLAS_PATH=/mnt/c/mappy-data/cache/sunlight
"@ | Set-Content C:\srv\mappy-hour\.env -Encoding UTF8

New-Item -ItemType Directory -Force C:\mappy-data\cache\sunlight | Out-Null
```

Autres variables (`MAPPY_FORCE_CACHE_ONLY=true`, `MAPPY_DATA_ROOT=/data`,
`NODE_ENV=production`) sont déjà fixées dans `docker-compose.yml` — l'image est immuable
quel que soit l'environnement, seul le chemin atlas hôte varie.

### 7.3 Peupler l'atlas

**Option A — robocopy depuis lappymaclapface (LAN, rapide) :**

```powershell
robocopy "D:\mappy-hour-data\cache\sunlight" "\\mitch\C$\mappy-data\cache\sunlight" /MIR /MT:8
```

**Option B — via le service `atlas-loader` (profil `loader`) :**

```powershell
wsl -d Ubuntu -u root -e bash -c '
cd /mnt/c/srv/mappy-hour
docker compose --profile loader run --rm atlas-loader \
  --repo=salfab/mappy-hour \
  --regions=lausanne,nyon,morges,vevey,geneve
'
```

Vérifier :

```powershell
Get-ChildItem C:\mappy-data\cache\sunlight -Recurse -Filter "*.idx" | Measure-Object
```

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
- **Cible SSH** : `${{ secrets.MITCH_SSH_USER }}@${{ secrets.MITCH_SSH_HOST }}`
- **Script lancé** : actuellement `mitch-deploy.ps1` ⚠️ — c'est le **flow Node.js natif
  legacy**, plus utilisé. **TODO (task #16) : pointer vers `mitch-deploy-docker.ps1`**.

### 10.2 Correctifs requis (task #16)

Dans `.github/workflows/deploy-mitch.yml`, l'étape `Deploy` doit lancer
`mitch-deploy-docker.ps1` :

```yaml
SCRIPT="mitch-deploy-docker.ps1"
if [ "$SKIP_PULL" = "true" ]; then
  SCRIPT="mitch-deploy-docker-no-pull.ps1"   # à créer si nécessaire
fi
```

Et `MITCH_SSH_USER` doit valoir `kiosque` (pas `devops`) — voir §3. Sinon, le script SSH
lance `wsl ...` dans la session devops, qui n'a pas de distro Ubuntu (et le mapping NAT
WSL2 n'est de toute façon pas visible côté kiosque).

### 10.3 Déclenchement manuel

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

### 11.2 Retiré (à restaurer) — task #14

Le `docker-compose.yml` prévoyait initialement :

```yaml
read_only: true
tmpfs: [/tmp]
cap_drop: [ALL]
security_opt: [no-new-privileges:true]
user: "node"
```

**Tout a été retiré.** Symptômes observés :

- `cap_drop: [ALL]` **seul** OU `security_opt: [no-new-privileges:true]` **seul** suffisent
  à faire crasher Next.js 16 ~50s après `▲ Next.js ... Ready`.
- Message dans `docker logs` : `ELIFECYCLE  Command failed.` sans autre stack trace.
- Le container reste UP mais le port 3000 ferme.

À investiguer : capabilities exactes requises. Hypothèse forte : `CAP_NET_BIND_SERVICE`
(bind port 3000 sans être root), `CAP_SETUID`, `CAP_SETGID`, `CAP_CHOWN` (pnpm + corepack
au démarrage). `read_only: true`, `tmpfs:/tmp` et `user: node` **n'ont jamais été testés
en isolation** — l'image runtime tourne en root et `node` existe dans l'image mais l'app
n'a pas été testée non-root.

**Surface de défense restante :** isolation WSL2 VM + Funnel HTTPS + bind loopback only +
volume atlas RO + security headers. Pas négligeable, mais explicitement en-dessous du
plan initial. Trade-off documenté ici par honnêteté — à corriger.

### 11.3 Reste à durcir

- [ ] Capabilities Docker minimales (task #14).
- [ ] `user: node` (UID non-root) dans le compose une fois validé.
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
# Doit lister lausanne/, nyon/, morges/, vevey/, geneve/

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
  --regions=lausanne,nyon,morges,vevey,geneve
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
