# Hébergement autonome — MappyHour

Ce dossier contient les outils pour prendre le contrôle d'un serveur Windows headless et le préparer
à héberger MappyHour. C'est **la première étape** : établir un accès SSH distant fiable via Tailscale.

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

## Étape 1 — Préparer une clé SSH sur la machine de développement

Si vous n'avez pas encore de clé SSH :

```powershell
ssh-keygen -t ed25519 -C "votre-email@exemple.com"
# Appuyez sur Entree pour accepter le chemin par defaut (~/.ssh/id_ed25519)
# Choisissez une passphrase (recommande)
```

Affichez votre clé publique :

```powershell
Get-Content "$env:USERPROFILE\.ssh\id_ed25519.pub"
```

---

## Étape 2 — Ajouter la clé publique à GitHub

1. Copiez la sortie de `id_ed25519.pub` (commence par `ssh-ed25519 …`)
2. Allez sur [github.com/settings/keys](https://github.com/settings/keys)
3. Cliquez **New SSH key**, collez la clé, donnez-lui un nom (ex: "Dev machine")

Le bootstrap récupérera automatiquement cette clé pour autoriser votre connexion au serveur.

---

## Étape 3 — Installer et connecter Tailscale sur la machine de développement

1. Téléchargez et installez [Tailscale](https://tailscale.com/download)
2. Connectez-vous à votre compte Tailscale
3. Vérifiez que vous êtes dans votre réseau :
   ```powershell
   tailscale status
   ```

---

## Étape 4 — Bootstrap du serveur headless

> **Vous avez besoin d'un écran et d'un clavier branchés sur le serveur pour cette étape uniquement.**

### Option A — Démarrage direct depuis internet (recommandé)

Pas besoin de copier de fichiers au préalable. Collez cette ligne dans une fenêtre PowerShell **en tant qu'Administrateur**, en remplaçant les quatre valeurs par les vôtres :

```powershell
$s="$env:TEMP\mappy-bootstrap.ps1"; Invoke-WebRequest https://raw.githubusercontent.com/salfab/mappy-hour/main/scripts/headless-server-selfhosting/bootstrap-headless-access.ps1 -OutFile $s -UseBasicParsing; notepad $s; powershell -ExecutionPolicy Bypass -File $s -GitHubUser VOTRE_GITHUB -MachineName VOTRE_MACHINE -SshUser devops -ProjectRoot C:\sources\mappy-hour
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

## Ce qui vient ensuite

Une fois le SSH établi, tout se fait à distance :

1. Installation de Docker Engine (sans Docker Desktop)
2. Login GHCR : `docker login ghcr.io`
3. Hydratation du volume de cache depuis un GitHub Release
4. Démarrage de l'application avec Docker Compose

Voir [`deploy-notes.md`](deploy-notes.md) pour l'architecture cible.

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
