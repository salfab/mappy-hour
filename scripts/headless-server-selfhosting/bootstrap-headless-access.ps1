# bootstrap-headless-access.ps1
#
# A exécuter UNE SEULE FOIS sur la machine Windows headless, écran/clavier branchés.
# Telecharge et lance le script de bootstrap Tailscale+OpenSSH depuis :
#   https://github.com/salfab/tailscale-bootstrap-windows
#
# Usage rapide (après avoir copié et édité config.local.ps1) :
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

function Ensure-Winget {
    if (Get-Command "winget.exe" -ErrorAction SilentlyContinue) {
        Write-OK "winget déjà disponible."
        return
    }

    Write-Host "    winget absent - tentative d'installation..." -ForegroundColor Yellow

    $vcLibsUrl  = "https://aka.ms/Microsoft.VCLibs.x64.14.00.Desktop.appx"
    $wingetUrl  = "https://github.com/microsoft/winget-cli/releases/latest/download/Microsoft.DesktopAppInstaller_8wekyb3d8bbwe.msixbundle"
    $vcLibsPath = Join-Path $env:TEMP "VCLibs.x64.appx"
    $wingetPath = Join-Path $env:TEMP "AppInstaller.msixbundle"

    try {
        Write-Host "    Téléchargement de VCLibs..." -ForegroundColor Gray
        Invoke-WebRequest $vcLibsUrl -OutFile $vcLibsPath -UseBasicParsing
        Write-Host "    Téléchargement de winget..." -ForegroundColor Gray
        Invoke-WebRequest $wingetUrl -OutFile $wingetPath -UseBasicParsing

        Add-AppxPackage $vcLibsPath -ErrorAction Stop
        Add-AppxPackage $wingetPath -ErrorAction Stop

        if (Get-Command "winget.exe" -ErrorAction SilentlyContinue) {
            Write-OK "winget installé avec succès."
        } else {
            Write-Warn "winget installé mais pas encore visible - redémarrez PowerShell si besoin."
        }
    } catch {
        Write-Warn "Installation automatique de winget échouée : $_"
        Write-Warn "Sur Windows Server, installez App Installer manuellement ou utilisez une autre méthode."
        Write-Warn "Le bootstrap Tailscale peut continuer sans winget si bootstrap.ps1 le gère autrement."
    }
}

# ---------------------------------------------------------------------------
# Vérification des droits administrateur
# ---------------------------------------------------------------------------

Write-Step "Vérification des droits administrateur"
$currentPrincipal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Fail "Ce script doit etre lance en tant qu'Administrateur. Clic droit > Executer en tant qu'administrateur."
}
Write-OK "Droits administrateur confirmés."

# ---------------------------------------------------------------------------
# Chargement de config.local.ps1 si present
# ---------------------------------------------------------------------------

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$configPath = Join-Path $scriptDir "config.local.ps1"

if (Test-Path $configPath) {
    Write-Step "Chargement de config.local.ps1"
    . $configPath
    Write-OK "Configuration chargée depuis $configPath"
} else {
    Write-Warn "config.local.ps1 introuvable - utilisation des paramètres passés en argument ou prompts."
}

# ---------------------------------------------------------------------------
# Validation des valeurs requises
# ---------------------------------------------------------------------------

Write-Step "Validation de la configuration"

if ([string]::IsNullOrWhiteSpace($GitHubUser)) {
    $GitHubUser = Read-Host "  Votre nom d'utilisateur GitHub (pour récupérer vos clés SSH)"
}
if ([string]::IsNullOrWhiteSpace($MachineName)) {
    $MachineName = Read-Host "  Nom court de cette machine (ex: petbox)"
}
if ([string]::IsNullOrWhiteSpace($SshUser)) {
    $SshUser = Read-Host "  Nom du compte SSH à créer (ex: devops)"
}
if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
    $ProjectRoot = Read-Host "  Dossier racine du projet (ex: C:\sources\mappy-hour)"
}

if ([string]::IsNullOrWhiteSpace($GitHubUser) -or
    [string]::IsNullOrWhiteSpace($MachineName) -or
    [string]::IsNullOrWhiteSpace($SshUser)     -or
    [string]::IsNullOrWhiteSpace($ProjectRoot)) {
    Fail "Des valeurs obligatoires sont vides. Relancez le script et remplissez tous les champs."
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
# Verification / installation de winget
# ---------------------------------------------------------------------------

Write-Step "Vérification de winget"
Ensure-Winget

# ---------------------------------------------------------------------------
# Telechargement du script de bootstrap
# ---------------------------------------------------------------------------

Write-Step "Téléchargement du script bootstrap depuis GitHub"

$rawUrl     = "https://raw.githubusercontent.com/$BootstrapRepoOwner/$BootstrapRepoName/$BootstrapRef/bootstrap.ps1"
$tempScript = Join-Path $env:TEMP "mappy-hour-bootstrap.ps1"

Write-Host "    URL : $rawUrl"
Write-Host "    Destination : $tempScript"

try {
    Invoke-WebRequest -Uri $rawUrl -OutFile $tempScript -UseBasicParsing
} catch {
    Fail "Impossible de telecharger le script. Verifiez la connexion internet et l'URL.`nErreur : $_"
}

Write-OK "Script téléchargé."

# ---------------------------------------------------------------------------
# Ouverture dans Notepad pour relecture avant execution
# ---------------------------------------------------------------------------

Write-Step "Ouverture du script dans Notepad pour relecture"
Write-Host "    Lisez le script, fermez Notepad, puis appuyez sur Entrée pour continuer."
Write-Host "    Si quelque chose vous semble suspect, fermez cette fenêtre PowerShell."
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
    Fail "Le bootstrap s'est terminé avec une erreur (code $LASTEXITCODE). Consultez les messages ci-dessus."
}

# ---------------------------------------------------------------------------
# Instructions finales
# ---------------------------------------------------------------------------

Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host "  Bootstrap terminé !" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
Write-Host ""
Write-Host "Prochaines etapes :"
Write-Host ""
Write-Host "  1. Connectez-vous à Tailscale sur cette machine si ce n'est pas fait."
Write-Host "     Ouvrez l'application Tailscale et cliquez sur 'Log in'."
Write-Host ""
Write-Host "  2. Sur votre machine de developpement, testez la connexion SSH :"
Write-Host "     ssh $SshUser@$MachineName"
Write-Host ""
Write-Host "  3. Ou utilisez le script de vérification fourni :"
Write-Host "     PowerShell.exe -File .\verify-ssh-access.ps1 -MachineName $MachineName -SshUser $SshUser"
Write-Host ""
Write-Host "  Une fois le SSH fonctionnel, vous n'avez plus besoin de l'écran ni du clavier."
Write-Host ""
