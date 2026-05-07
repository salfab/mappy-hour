# bootstrap-headless-access.ps1
#
# A executer UNE SEULE FOIS sur la machine Windows headless, ecran/clavier branches.
# Telecharge et lance le script de bootstrap Tailscale+OpenSSH depuis :
#   https://github.com/salfab/tailscale-bootstrap-windows
#
# Usage rapide (apres avoir copie et edite config.local.ps1) :
#   PowerShell.exe -ExecutionPolicy Bypass -File .\bootstrap-headless-access.ps1
#
# Usage sans config.local.ps1 :
#   PowerShell.exe -ExecutionPolicy Bypass -File .\bootstrap-headless-access.ps1 `
#     -GitHubUser salfab -MachineName petbox -SshUser devops -ProjectRoot C:\sources\mappy-hour

#Requires -Version 5.1
param(
    [string]$GitHubUser        = "",
    [string]$MachineName       = "",
    [string]$SshUser           = "",
    [string]$ProjectRoot       = "",
    [string]$BootstrapRepoOwner = "salfab",
    [string]$BootstrapRepoName  = "tailscale-bootstrap-windows",
    [string]$BootstrapRef       = "main"
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

function Fail {
    param([string]$Message)
    Write-Host ""
    Write-Host "[ERREUR] $Message" -ForegroundColor Red
    Write-Host ""
    exit 1
}

# ---------------------------------------------------------------------------
# Verification des droits administrateur
# ---------------------------------------------------------------------------

Write-Step "Verification des droits administrateur"
$currentPrincipal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Fail "Ce script doit etre lance en tant qu'Administrateur. Clic droit > Executer en tant qu'administrateur."
}
Write-OK "Droits administrateur confirmes."

# ---------------------------------------------------------------------------
# Chargement de config.local.ps1 si present
# ---------------------------------------------------------------------------

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$configPath = Join-Path $scriptDir "config.local.ps1"

if (Test-Path $configPath) {
    Write-Step "Chargement de config.local.ps1"
    . $configPath
    Write-OK "Configuration chargee depuis $configPath"
} else {
    Write-Warn "config.local.ps1 introuvable — utilisation des parametres passes en argument."
    Write-Warn "Conseil : copiez config.example.ps1 en config.local.ps1 et remplissez les valeurs."
}

# ---------------------------------------------------------------------------
# Validation des valeurs requises
# ---------------------------------------------------------------------------

Write-Step "Validation de la configuration"

$missing = @()
if ([string]::IsNullOrWhiteSpace($GitHubUser))  { $missing += "GitHubUser" }
if ([string]::IsNullOrWhiteSpace($MachineName))  { $missing += "MachineName" }
if ([string]::IsNullOrWhiteSpace($SshUser))      { $missing += "SshUser" }
if ([string]::IsNullOrWhiteSpace($ProjectRoot))  { $missing += "ProjectRoot" }

if ($missing.Count -gt 0) {
    Fail ("Valeurs manquantes : " + ($missing -join ", ") + "`n" +
          "Remplissez config.local.ps1 ou passez ces valeurs en parametres.")
}

Write-OK "GitHubUser  : $GitHubUser"
Write-OK "MachineName : $MachineName"
Write-OK "SshUser     : $SshUser"
Write-OK "ProjectRoot : $ProjectRoot"
Write-OK "Bootstrap   : $BootstrapRepoOwner/$BootstrapRepoName@$BootstrapRef"

# ---------------------------------------------------------------------------
# Avertissement sur la mutabilite de la ref
# ---------------------------------------------------------------------------

if ($BootstrapRef -eq "main" -or $BootstrapRef -eq "master") {
    Write-Warn "La ref '$BootstrapRef' est mutable (branche). Pour un usage en production,"
    Write-Warn "preferez un tag de release ou un SHA complet dans config.local.ps1."
    Write-Warn "Exemple : `$BootstrapRef = 'v1.2.0'  ou  `$BootstrapRef = 'a3f9c1d...'"
}

# ---------------------------------------------------------------------------
# Telechargement du script de bootstrap
# ---------------------------------------------------------------------------

Write-Step "Telechargement du script bootstrap depuis GitHub"

$rawUrl     = "https://raw.githubusercontent.com/$BootstrapRepoOwner/$BootstrapRepoName/$BootstrapRef/bootstrap.ps1"
$tempScript = Join-Path $env:TEMP "mappy-hour-bootstrap.ps1"

Write-Host "    URL : $rawUrl"
Write-Host "    Destination : $tempScript"

try {
    Invoke-WebRequest -Uri $rawUrl -OutFile $tempScript -UseBasicParsing
} catch {
    Fail "Impossible de telecharger le script. Verifiez la connexion internet et l'URL.`nErreur : $_"
}

Write-OK "Script telecharge."

# ---------------------------------------------------------------------------
# Ouverture dans Notepad pour relecture avant execution
# ---------------------------------------------------------------------------

Write-Step "Ouverture du script dans Notepad pour relecture"
Write-Host "    Lisez le script, fermez Notepad, puis appuyez sur Entree pour continuer."
Write-Host "    Si quelque chose vous semble suspect, fermez cette fenetre PowerShell."
Write-Host ""

Start-Process -FilePath "notepad.exe" -ArgumentList $tempScript -Wait

Write-Host ""
$confirm = Read-Host "Appuyez sur Entree pour lancer le bootstrap (Ctrl+C pour annuler)"

# ---------------------------------------------------------------------------
# Execution du script de bootstrap
# ---------------------------------------------------------------------------

Write-Step "Lancement du bootstrap Tailscale + OpenSSH"

& powershell.exe -ExecutionPolicy Bypass -File $tempScript `
    -GitHubUser $GitHubUser `
    -MachineName $MachineName `
    -SshUser $SshUser `
    -ProjectRoot $ProjectRoot

if ($LASTEXITCODE -ne 0) {
    Fail "Le bootstrap s'est termine avec une erreur (code $LASTEXITCODE). Consultez les messages ci-dessus."
}

# ---------------------------------------------------------------------------
# Instructions finales
# ---------------------------------------------------------------------------

Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host "  Bootstrap termine !" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
Write-Host ""
Write-Host "Prochaines etapes :"
Write-Host ""
Write-Host "  1. Connectez-vous a Tailscale sur cette machine si ce n'est pas fait."
Write-Host "     Ouvrez l'application Tailscale et cliquez sur 'Log in'."
Write-Host ""
Write-Host "  2. Sur votre machine de developpement, testez la connexion SSH :"
Write-Host "     ssh $SshUser@$MachineName"
Write-Host ""
Write-Host "  3. Ou utilisez le script de verification fourni :"
Write-Host "     PowerShell.exe -File .\verify-ssh-access.ps1 -MachineName $MachineName -SshUser $SshUser"
Write-Host ""
Write-Host "  Une fois le SSH fonctionnel, vous n'avez plus besoin de l'ecran ni du clavier."
Write-Host ""
