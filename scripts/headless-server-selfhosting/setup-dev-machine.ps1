# setup-dev-machine.ps1
#
# À exécuter UNE FOIS sur votre machine de développement avant le bootstrap du serveur headless.
# Vérifie ou génère une clé SSH, l'affiche, la copie dans le presse-papier,
# et ouvre GitHub pour que vous puissiez l'ajouter à votre compte.
#
# Usage :
#   .\setup-dev-machine.ps1
#   .\setup-dev-machine.ps1 -Email votre@email.com

#Requires -Version 5.1
param(
    [string]$Email = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------------------
# Fonctions utilitaires
# ---------------------------------------------------------------------------

function Write-Step {
    param([string]$Message)
    Write-Host ""
    Write-Host ">>> $Message" -ForegroundColor Cyan
}

function Write-OK {
    param([string]$Message)
    Write-Host "    [OK] $Message" -ForegroundColor Green
}

function Write-Warn {
    param([string]$Message)
    Write-Host "    [!]  $Message" -ForegroundColor Yellow
}

function Write-Info {
    param([string]$Message)
    Write-Host "    $Message"
}

# ---------------------------------------------------------------------------
# En-tête
# ---------------------------------------------------------------------------

Write-Host ""
Write-Host "============================================================"
Write-Host "  MappyHour - Préparation de la machine de développement"
Write-Host "============================================================"

# ---------------------------------------------------------------------------
# 1. Vérification du client SSH
# ---------------------------------------------------------------------------

Write-Step "Vérification du client SSH"

$sshExe = Get-Command "ssh.exe" -ErrorAction SilentlyContinue
if ($null -eq $sshExe) {
    Write-Host "    [KO] ssh.exe introuvable." -ForegroundColor Red
    Write-Warn "Activez OpenSSH Client : Paramètres > Applications > Fonctionnalités facultatives > OpenSSH Client"
    exit 1
}
Write-OK "ssh.exe disponible : $($sshExe.Source)"

$sshKeygenExe = Get-Command "ssh-keygen.exe" -ErrorAction SilentlyContinue
if ($null -eq $sshKeygenExe) {
    Write-Host "    [KO] ssh-keygen.exe introuvable." -ForegroundColor Red
    exit 1
}
Write-OK "ssh-keygen.exe disponible."

# ---------------------------------------------------------------------------
# 2. Recherche d'une clé SSH existante
# ---------------------------------------------------------------------------

Write-Step "Recherche d'une clé SSH existante"

$sshDir     = Join-Path $env:USERPROFILE ".ssh"
$keyFiles   = @("id_ed25519", "id_ecdsa", "id_rsa")
$foundKey   = $null
$foundPub   = $null

foreach ($name in $keyFiles) {
    $priv = Join-Path $sshDir $name
    $pub  = "$priv.pub"
    if ((Test-Path $priv) -and (Test-Path $pub)) {
        $foundKey = $priv
        $foundPub = $pub
        Write-OK "Clé existante trouvée : $priv"
        break
    }
}

# ---------------------------------------------------------------------------
# 3. Génération d'une clé si absente
# ---------------------------------------------------------------------------

if ($null -eq $foundKey) {
    Write-Step "Aucune clé SSH trouvée - génération d'une clé ed25519"

    if (-not (Test-Path $sshDir)) {
        New-Item -ItemType Directory -Path $sshDir | Out-Null
    }

    if ([string]::IsNullOrWhiteSpace($Email)) {
        $Email = Read-Host "    Votre adresse email (pour identifier la clé)"
    }

    $keyPath = Join-Path $sshDir "id_ed25519"
    Write-Info "Génération de la clé dans $keyPath ..."
    Write-Info "(Vous pouvez entrer une passphrase ou appuyer sur Entrée pour ne pas en mettre)"
    Write-Host ""

    & ssh-keygen.exe -t ed25519 -C $Email -f $keyPath

    if (-not (Test-Path "$keyPath.pub")) {
        Write-Host "    [KO] La génération a échoué." -ForegroundColor Red
        exit 1
    }

    $foundKey = $keyPath
    $foundPub = "$keyPath.pub"
    Write-OK "Clé générée avec succès."
}

# ---------------------------------------------------------------------------
# 4. Affichage et copie de la clé publique
# ---------------------------------------------------------------------------

Write-Step "Clé publique SSH"

$pubKeyContent = Get-Content $foundPub -Raw
$pubKeyContent = $pubKeyContent.Trim()

Write-Host ""
Write-Host "    ----------------------------------------------------------------"
Write-Host "    $pubKeyContent" -ForegroundColor White
Write-Host "    ----------------------------------------------------------------"
Write-Host ""

try {
    $pubKeyContent | Set-Clipboard
    Write-OK "Clé copiée dans le presse-papier."
} catch {
    Write-Warn "Impossible de copier automatiquement. Copiez la ligne ci-dessus manuellement."
}

# ---------------------------------------------------------------------------
# 5. Ouverture de GitHub pour ajouter la clé
# ---------------------------------------------------------------------------

Write-Step "Ajout de la clé sur GitHub"
Write-Info "La clé publique est dans le presse-papier."
Write-Info "La page GitHub va s'ouvrir dans votre navigateur."
Write-Host ""

$open = Read-Host "    Appuyez sur Entrée pour ouvrir github.com/settings/keys (Ctrl+C pour ignorer)"

Start-Process "https://github.com/settings/keys"

Write-Host ""
Write-Info "Sur GitHub :"
Write-Info "  1. Cliquez 'New SSH key'"
Write-Info "  2. Donnez un titre (ex: Dev machine)"
Write-Info "  3. Collez la clé (Ctrl+V) dans le champ 'Key'"
Write-Info "  4. Cliquez 'Add SSH key'"

# ---------------------------------------------------------------------------
# 6. Vérification de Tailscale
# ---------------------------------------------------------------------------

Write-Step "Vérification de Tailscale"

$tsExe = Get-Command "tailscale.exe" -ErrorAction SilentlyContinue
if ($null -eq $tsExe) {
    Write-Warn "Tailscale n'est pas installé sur cette machine."
    Write-Warn "Téléchargez-le sur https://tailscale.com/download et connectez-vous à votre réseau."
} else {
    $tsStatus = & tailscale.exe status 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-OK "Tailscale connecté."
    } else {
        Write-Warn "Tailscale est installé mais non connecté. Lancez : tailscale.exe up"
    }
}

# ---------------------------------------------------------------------------
# Récapitulatif
# ---------------------------------------------------------------------------

Write-Host ""
Write-Host "============================================================"
Write-Host "  Prêt pour le bootstrap !" -ForegroundColor Green
Write-Host "============================================================"
Write-Host ""
Write-Host "  Clé publique : $foundPub"
Write-Host ""
Write-Host "  Prochaine étape : sur le serveur headless (écran branché),"
Write-Host "  lancez bootstrap-headless-access.ps1"
Write-Host ""
