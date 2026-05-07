# config.example.ps1  - Template de configuration pour le bootstrap headless MappyHour
#
# Usage : copier ce fichier en config.local.ps1 et remplir les valeurs.
# config.local.ps1 est ignore par git  - ne le commitez jamais.
#
#   Copy-Item config.example.ps1 config.local.ps1
#   notepad config.local.ps1

# Votre nom d'utilisateur GitHub.
# Utilise pour recuperer vos cles SSH publiques depuis https://github.com/<GitHubUser>.keys
$GitHubUser = "your-github-username"

# Nom court de la machine headless (sans domaine).
# Ce nom sera utilise comme hostname dans Tailscale et pour se connecter en SSH.
# Exemple : "petbox", "nuc-salon", "homeserver"
$MachineName = "petbox"

# Nom du compte local Windows cree sur le serveur headless pour l'administration SSH.
# Ce compte sera membre du groupe Administrateurs locaux.
$SshUser = "devops"

# Dossier racine du projet MappyHour sur le serveur headless.
# Sera cree s'il n'existe pas.
$ProjectRoot = "C:\sources\mappy-hour"

# Coordonnees du repo GitHub qui contient le script de bootstrap Tailscale+OpenSSH.
# Ne modifiez ces valeurs que si vous avez forke le repo.
$BootstrapRepoOwner = "salfab"
$BootstrapRepoName  = "tailscale-bootstrap-windows"

# Ref Git a utiliser pour telecharger bootstrap.ps1 (branche, tag, ou SHA complet).
# "main" est pratique mais mutable  - pour un usage en production, privilegiez
# un tag de release ou un SHA complet pour garantir la reproductibilite.
$BootstrapRef = "main"
