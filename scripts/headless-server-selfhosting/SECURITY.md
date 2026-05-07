# Sécurité — scripts/headless-server-selfhosting

Ce document explique les choix de sécurité de ce dossier et leurs limites.

---

## Ce que ce dossier ne contient pas — et pourquoi

**Aucun secret n'est commité ici.**

- Pas de clé SSH privée
- Pas d'auth key Tailscale
- Pas de token GitHub
- Pas de mot de passe

Ces valeurs existent uniquement sur votre machine locale, dans des fichiers ignorés par git
(`config.local.ps1`, `~/.ssh/id_*`). Le dépôt peut être public sans risque.

---

## Pourquoi on n'utilise pas `Invoke-Expression`

La commande `iex` (alias de `Invoke-Expression`) exécute une chaîne de caractères comme du code PowerShell.
Combinée à un téléchargement réseau, elle donne quelque chose comme :

```powershell
# NE PAS FAIRE
iwr https://exemple.com/script.ps1 | iex
```

Cette pratique est dangereuse car :

1. Le script est exécuté sans que vous puissiez le lire.
2. Une attaque man-in-the-middle (ou un compte GitHub compromis) peut substituer du code malveillant.
3. Il n'y a aucune trace locale de ce qui a été exécuté.

**Ce qu'on fait à la place :**

1. `Invoke-WebRequest` sauvegarde le script dans `%TEMP%`.
2. Notepad s'ouvre pour que vous puissiez lire le script.
3. Vous fermez Notepad et confirmez avant l'exécution.
4. `& powershell.exe -File $tempScript` exécute le fichier — pas une chaîne.

---

## Pourquoi SSH est restreint au réseau Tailscale

SSH expose un accès complet à la machine. Sans restriction réseau, n'importe quelle IP peut tenter
de se connecter (attaques par force brute, scan de port, exploitation de vulnérabilités sshd).

Tailscale crée un réseau privé chiffré (WireGuard). En configurant sshd pour n'écouter que sur
l'interface Tailscale, le port SSH devient invisible depuis internet.

Le durcissement réseau (restriction de l'écoute sshd, règles pare-feu) est géré par
[salfab/tailscale-bootstrap-windows](https://github.com/salfab/tailscale-bootstrap-windows).

---

## Pourquoi le durcissement réel est dans le repo bootstrap

Ce dossier est le point d'entrée *projet* pour MappyHour.
La logique de durcissement OS (sshd_config, pare-feu, comptes locaux) vit dans
`salfab/tailscale-bootstrap-windows` pour deux raisons :

- **Réutilisabilité** : d'autres projets peuvent utiliser le même bootstrap.
- **Séparation des responsabilités** : ce repo contient le code de l'application, pas la config OS.

---

## Procédure de révocation d'accès

Si un appareil ou un compte est compromis :

### Révoquer l'accès Tailscale

1. Connectez-vous sur [login.tailscale.com](https://login.tailscale.com/admin/machines).
2. Trouvez la machine concernée et cliquez sur **Remove**.
3. La machine est immédiatement isolée du réseau privé.

### Révoquer une clé SSH

1. Sur GitHub : Paramètres → SSH and GPG keys → supprimer la clé compromise.
2. Sur le serveur (via un autre accès ou écran/clavier) :
   ```
   notepad C:\ProgramData\ssh\administrators_authorized_keys
   ```
   Supprimez la ligne correspondant à la clé compromise.

### Désactiver un compte local

```powershell
Disable-LocalUser -Name "devops"
```

---

## Limites de ce modèle de sécurité

Ce setup protège contre les attaques réseau courantes, mais il a des limites :

| Menace | Protégé ? | Remarque |
|--------|-----------|----------|
| Scan de port depuis internet | Oui | SSH non accessible hors Tailscale |
| Brute force SSH | Oui | SSH restreint au réseau Tailscale |
| Compromission du compte GitHub | **Non** | Un attaquant peut injecter une clé SSH ou modifier bootstrap.ps1 |
| Compromission du compte Tailscale | **Non** | L'accès au réseau privé serait perdu ou détourné |
| Compromission de la machine dev | **Non** | La clé SSH privée y est stockée |
| Accès physique au serveur | **Non** | Un attaquant avec accès physique contourne tout |
| Script bootstrap malveillant | Partiellement | Notepad permet la relecture, mais suppose que vous la faites |

**En résumé :** ce modèle suppose que vos comptes GitHub et Tailscale sont sains, et que votre
machine de développement n'est pas compromise. C'est une hypothèse raisonnable pour un usage
personnel ou une petite équipe.
