# Hébergement autonome — MappyHour

Ce dossier contient les outils pour prendre le contrôle d'un serveur Windows headless et le préparer
à héberger MappyHour. C'est **la première étape** : établir un accès SSH distant fiable via Tailscale.

> **Install fresh end-to-end (Tailscale + SSH + WSL2 + Docker + repo + secrets GHA) :**
> utiliser `scripts/deploy/mitch-bootstrap.ps1` (cf. `scripts/deploy/README.md` et
> `docs/deploy.md` §0). Ce dossier-ci reste utile pour comprendre / décomposer la phase
> Tailscale+SSH du bootstrap, ou pour le faire à la main.

---

## Ce que ce dossier fait

- Guider le bootstrap Tailscale + OpenSSH sur une machine Windows (NUC, mini-PC…)
- Vérifier que la connexion SSH fonctionne depuis votre machine de développement
- Produire un rapport d'état du serveur avant le déploiement

## Ce que ce dossier ne fait PAS encore

Cette étape ne touche pas à :

- Docker / Docker Desktop
- Docker Compose
- Node.js / l'application MappyHour
- GHCR (registry d'images)
- GitHub Actions runner
- Caddy, Portainer, Kubernetes
- Le déploiement de l'application

Tout cela sera fait **à distance via SSH** une fois l'accès établi.  
Voir [`deploy-notes.md`](deploy-notes.md) pour la suite prévue.

---

## Architecture

```
Machine de developpement
        |
        |  SSH chiffre (WireGuard/Tailscale)
        |
Reseau prive Tailscale
        |
        |
Serveur Windows headless
        |
        |  OpenSSH Server
        |
Administration PowerShell a distance
```

Le bootstrap Tailscale + OpenSSH est géré par un repo dédié :
**[salfab/tailscale-bootstrap-windows](https://github.com/salfab/tailscale-bootstrap-windows)**

Ce dossier est le point d'entrée projet pour MappyHour — il appelle ce repo, il ne le réimplémente pas.

---

## Prérequis

**Sur votre machine de développement :**

- PowerShell 5.1+ (intégré à Windows 10/11)
- Un client SSH (`ssh` est inclus dans Windows 10/11)
- [Tailscale](https://tailscale.com/download) installé et connecté à votre réseau

**Sur le serveur headless (une seule fois, écran/clavier branchés) :**

- Windows 10/11 ou Windows Server 2019+
- Accès internet
- Un compte administrateur local pour lancer le bootstrap

**Sur GitHub :**

- Un compte GitHub avec votre clé SSH publique ajoutée

---

## Étapes 1–3 — Préparer la machine de développement

Un seul script fait tout : génère la clé SSH si absente, la copie dans le presse-papier, ouvre GitHub pour l'ajouter, et vérifie Tailscale.

```powershell
.\setup-dev-machine.ps1
```

Ou avec votre email en paramètre pour éviter la question :

```powershell
.\setup-dev-machine.ps1 -Email votre@email.com
```

Le script :
1. Vérifie ou génère une clé SSH ed25519 dans `~/.ssh/`
2. Affiche la clé publique et la copie dans le presse-papier
3. Ouvre [github.com/settings/keys](https://github.com/settings/keys) pour que vous la colliez
4. Vérifie que Tailscale est installé et connecté

> Si Tailscale n'est pas installé, téléchargez-le sur [tailscale.com/download](https://tailscale.com/download) et connectez-vous à votre réseau avant de continuer.

---

## Étape 4 — Bootstrap du serveur headless

> **Vous avez besoin d'un écran et d'un clavier branchés sur le serveur pour cette étape uniquement.**

### Option A — Démarrage direct depuis internet (recommandé)

Pas besoin de copier de fichiers au préalable. Collez cette ligne dans une fenêtre PowerShell **en tant qu'Administrateur**, en remplaçant les quatre valeurs par les vôtres :

```powershell
$s="$env:TEMP\mappy-bootstrap.ps1"; Remove-Item $s -Force -ErrorAction SilentlyContinue; Invoke-WebRequest https://raw.githubusercontent.com/salfab/mappy-hour/main/scripts/headless-server-selfhosting/bootstrap-headless-access.ps1 -OutFile $s -UseBasicParsing; notepad $s; powershell -ExecutionPolicy Bypass -File $s -GitHubUser VOTRE_GITHUB -MachineName VOTRE_MACHINE -SshUser devops -ProjectRoot C:\sources\mappy-hour
```

Ce que ça fait, dans l'ordre :
1. Télécharge `bootstrap-headless-access.ps1` dans `%TEMP%`
2. L'ouvre dans Notepad — lisez-le, fermez quand vous êtes prêt
3. Le lance avec vos paramètres (téléchargera à son tour `bootstrap.ps1` depuis `salfab/tailscale-bootstrap-windows`, avec une nouvelle étape Notepad)

### Option B — Depuis le repo cloné

Si vous avez déjà ce dossier sur le serveur (clé USB, partage réseau…) :

```powershell
Copy-Item config.example.ps1 config.local.ps1
notepad config.local.ps1
```

Remplissez les valeurs dans Notepad :

```powershell
$GitHubUser = "votre-compte-github"   # pour recuperer vos cles SSH
$MachineName = "petbox"               # nom court de cette machine
$SshUser     = "devops"               # compte admin SSH a creer
$ProjectRoot = "C:\sources\mappy-hour"
```

Enregistrez et fermez Notepad, puis :

```powershell
PowerShell.exe -ExecutionPolicy Bypass -File .\bootstrap-headless-access.ps1
```

### Ce que fait le bootstrap

1. Télécharge `bootstrap.ps1` depuis `salfab/tailscale-bootstrap-windows`
2. L'ouvre dans Notepad pour que vous puissiez le lire
3. Vous demande confirmation avant de l'exécuter
4. Installe Tailscale, OpenSSH, crée le compte SSH, configure les clés

### Connecter Tailscale

Après le bootstrap, Tailscale affichera une URL de connexion dans le terminal.  
Ouvrez-la dans un navigateur et connectez-vous à votre compte Tailscale.

---

## Étape 5 — Vérifier la connexion SSH depuis la machine de développement

> Vous pouvez maintenant débrancher écran et clavier du serveur.

Depuis votre machine de développement :

```powershell
cd scripts\headless-server-selfhosting
.\verify-ssh-access.ps1 -MachineName petbox -SshUser devops
```

Si tout va bien, vous verrez :

```
>>> Test SSH vers nom Tailscale (devops@petbox)
    [OK] Connexion SSH reussie. Hostname retourne : PETBOX
```

Connexion manuelle :

```powershell
ssh devops@petbox
```

---

## Étape 6 — Rapport d'état du serveur (preflight)

Copiez le script de preflight sur le serveur et exécutez-le via SSH :

```powershell
scp .\remote-server-preflight.ps1 devops@petbox:C:/sources/mappy-hour/remote-server-preflight.ps1
ssh devops@petbox "powershell -ExecutionPolicy Bypass -File C:\sources\mappy-hour\remote-server-preflight.ps1"
```

Le rapport liste : version Windows/PowerShell, statut Tailscale, sshd, pare-feu, espace disque,
présence de Docker.

---

## Étape 7 — Exposer l'application via Tailscale Funnel

> **Prérequis :** l'application doit être en cours d'exécution sur le serveur (port 3000 local).  
> Cette étape doit être faite depuis une **session interactive de l'utilisateur qui possède Tailscale** (celui connecté au tailnet — souvent un compte différent du compte SSH `devops`).

Tailscale Funnel permet d'exposer le port local 3000 en HTTPS public sans ouvrir de port sur le routeur, sans gérer de certificat TLS.

### Prérequis dans la Tailscale admin console

1. **HTTPS activé** : `login.tailscale.com/admin` → DNS → "HTTPS Certificates" → on  
2. **Funnel autorisé** pour ce nœud — dans Access Controls, ajouter :
   ```json
   "nodeAttrs": [
     { "target": ["<nom-de-la-machine>"], "attr": ["funnel"] }
   ]
   ```
   Remplacer `<nom-de-la-machine>` par le nom Tailscale du serveur (visible dans `tailscale status`).

### Commandes (depuis la session interactive qui possède Tailscale)

```powershell
# Proxy HTTPS → localhost:3000 (tailnet uniquement)
tailscale serve --bg --https=443 http://127.0.0.1:3000

# Activer l'exposition publique (Funnel = accès internet)
# Le port cible est le port LOCAL (3000), pas 443 — Tailscale gère le HTTPS côté public
tailscale funnel --bg 3000

# Vérifier
tailscale serve status
tailscale funnel status
```

> **Note syntaxe** : `tailscale funnel 443 on` est l'ancienne syntaxe (dépréciée depuis ~v1.50+).  
> La nouvelle syntaxe prend le **port local** comme argument : `tailscale funnel --bg 3000`.

L'URL publique sera : `https://<nom-machine>.<tailnet>.ts.net`

### Désactiver / couper l'accès public

```powershell
tailscale funnel 443 off
tailscale serve --https=443 off
```

### Notes

- Si Tailscale tourne sous un compte différent du compte SSH `devops` (cas fréquent sur Windows où le daemon Tailscale est lié à la session interactive), les commandes `tailscale serve/funnel` doivent être lancées depuis **cette session**, pas via SSH.
- La configuration Funnel est persistante : elle survit aux redémarrages du daemon Tailscale.
- Tailscale Funnel injecte les headers `Tailscale-User-*` uniquement pour le trafic tailnet, pas pour le trafic Funnel public — l'application ne peut pas s'en servir pour de l'auth.

---

## Déployer une mise à jour

Le déploiement courant utilise **Docker dans WSL2 côté session kiosque** sur mitch et
est piloté par GitHub Actions (`.github/workflows/deploy-mitch.yml`) à chaque push sur
`master`. Voir [`../../docs/deploy.md`](../../docs/deploy.md) pour la procédure complète
(setup initial WSL2/Docker, image GHCR, bind-mount atlas, OAuth Tailscale CI/CD,
persistance WSL2, diagnostic 502 Funnel).

Pour déclencher un déploiement manuel :

```powershell
# Cible : kiosque (pas devops — explication dans deploy.md §3)
ssh kiosque@mitch "powershell -File C:\srv\mappy-hour\scripts\headless-server-selfhosting\mitch-deploy-docker.ps1"
```

Le script `mitch-deploy-docker.ps1` fait, dans l'ordre :

1. `git pull` — récupère la dernière version du `docker-compose.yml` / `.env.example`
2. `wsl docker compose pull` — récupère la dernière image depuis GHCR
3. `wsl docker compose up -d --remove-orphans` — redémarre les services
4. Attend 25 s puis vérifie `http://127.0.0.1:3000/api/datasets`

### Voir les logs après déploiement

```powershell
ssh devops@mitch "wsl -d Ubuntu -u root -e bash -c 'docker logs mappy-hour --tail 30'"
```

### Flow legacy (Node.js natif, avant 2026-05)

Pour mémoire, l'ancien script `mitch-deploy.ps1` faisait `git pull` → `pnpm install`
→ `pnpm build` → kill + redémarrage WMI. Conservé dans le repo pour rollback ou
pour les machines sans Docker, mais **plus utilisé sur mitch**.

> **Note** : à l'heure actuelle, `.github/workflows/deploy-mitch.yml` pointe encore sur
> `mitch-deploy.ps1` (legacy) et `MITCH_SSH_USER=devops`. C'est une dette identifiée
> (task #16) : à corriger pour pointer sur `mitch-deploy-docker.ps1` et SSH-as-kiosque.

---

## Ce qui vient ensuite

Une fois le SSH et Funnel établis, le reste se fait à distance — voir
[`../../docs/deploy.md`](../../docs/deploy.md) section "Étape 2" pour le détail :

1. Installation de WSL2 + Ubuntu + Docker Engine (pas Docker Desktop)
2. Pull de l'image GHCR `ghcr.io/salfab/mappy-hour:latest` (publique, pas de login)
3. Configuration du bind-mount atlas via `MAPPY_ATLAS_PATH` dans `.env`
4. Peuplement de `C:\mappy-data\cache\sunlight\` (robocopy depuis machine de précompute, ou service `atlas-loader`)
5. `docker compose up -d`

---

## Ajouter une nouvelle machine de développement

Si une deuxième machine doit pouvoir se connecter au serveur headless :

1. Sur la nouvelle machine, générez une clé SSH et ajoutez-la sur GitHub :
   ```powershell
   .\setup-dev-machine.ps1 -Email votre@email.com
   ```

2. Une fois la clé ajoutée sur GitHub, depuis **n'importe quelle machine déjà autorisée**, rafraîchissez les clés sur le serveur :
   ```powershell
   ssh devops@petbox "powershell -Command ""(Invoke-WebRequest https://github.com/salfab.keys -UseBasicParsing).Content | Set-Content 'C:\ProgramData\ssh\administrators_authorized_keys'"""
   ```

   Ou directement **sur le serveur** (via écran/clavier ou session SSH existante) :
   ```powershell
   (Invoke-WebRequest https://github.com/salfab.keys -UseBasicParsing).Content | Set-Content 'C:\ProgramData\ssh\administrators_authorized_keys'
   ```

Cette commande resynchronise `administrators_authorized_keys` avec toutes les clés publiques du compte GitHub `salfab`. Elle est **idempotente** — vous pouvez la relancer à tout moment.

---

## Dépannage

| Symptôme | Cause probable | Solution |
|----------|----------------|----------|
| `ssh: connect to host petbox port 22: Connection timed out` | Tailscale non connecté | Vérifiez `tailscale status` sur les deux machines |
| `Permission denied (publickey)` | Clé SSH non reconnue | Vérifiez que votre clé est sur github.com/settings/keys |
| `Could not resolve hostname petbox` | MagicDNS non activé | Activez MagicDNS dans l'admin Tailscale, ou utilisez l'IP directe |
| Notepad s'ouvre mais le script est vide | Téléchargement échoué | Vérifiez la connexion internet et la ref dans `config.local.ps1` |
| `Accès refusé` au lancement du bootstrap | Pas administrateur | Clic droit sur PowerShell → "Exécuter en tant qu'administrateur" |

---

## Notes de sécurité

Voir [`SECURITY.md`](SECURITY.md) pour le détail complet.

Points essentiels :
- `config.local.ps1` est ignoré par git — ne le commitez jamais
- Ne jamais coller `iwr ... | iex` dans PowerShell : le script est toujours sauvegardé localement et inspecté avant exécution
- SSH n'est accessible que via le réseau Tailscale
- Pour révoquer l'accès : supprimer la machine dans l'admin Tailscale et retirer la clé SSH sur GitHub
