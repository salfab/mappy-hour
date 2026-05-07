# verify-ssh-access.ps1
#
# A executer sur votre machine de developpement apres le bootstrap.
# Verifie que Tailscale est actif et que la connexion SSH vers le serveur headless fonctionne.
# Ne modifie rien sur le serveur.
#
# Usage :
#   .\verify-ssh-access.ps1 -MachineName petbox -SshUser devops
#   .\verify-ssh-access.ps1 -MachineName petbox -SshUser devops -TailscaleIp 100.64.0.42

#Requires -Version 5.1
Set-StrictMode -Version Latest
$ErrorActionPreference = "SilentlyContinue"

param(
    [Parameter(Mandatory = $true)]
    [string]$MachineName,

    [Parameter(Mandatory = $true)]
    [string]$SshUser,

    [string]$TailscaleIp = ""
)

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

function Write-Fail {
    param([string]$Message)
    Write-Host "    [KO] $Message" -ForegroundColor Red
}

function Write-Hint {
    param([string]$Message)
    Write-Host "         -> $Message" -ForegroundColor Yellow
}

function Test-SshHost {
    param(
        [string]$Host,
        [string]$User,
        [string]$Label
    )
    Write-Step "Test SSH vers $Label ($User@$Host)"
    $result = & ssh -o ConnectTimeout=10 -o BatchMode=yes -o StrictHostKeyChecking=accept-new `
                    "$User@$Host" "hostname" 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-OK "Connexion SSH reussie. Hostname retourne : $result"
        return $true
    } else {
        Write-Fail "Connexion SSH echouee."
        Write-Host "    Sortie : $result"
        return $false
    }
}

# ---------------------------------------------------------------------------
# 1. Verifier que Tailscale est disponible et actif
# ---------------------------------------------------------------------------

Write-Step "Verification de Tailscale sur cette machine"

$tailscaleExe = Get-Command "tailscale.exe" -ErrorAction SilentlyContinue
if (-not $tailscaleExe) {
    Write-Fail "tailscale.exe introuvable dans le PATH."
    Write-Hint "Installez Tailscale sur votre machine de dev : https://tailscale.com/download"
} else {
    $tsStatus = & tailscale.exe status 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-OK "Tailscale actif."
        Write-Host "    $tsStatus" | Select-Object -First 5
    } else {
        Write-Fail "Tailscale ne repond pas ou n'est pas connecte."
        Write-Hint "Ouvrez l'application Tailscale et connectez-vous."
        Write-Hint "Commande : tailscale.exe up"
    }
}

# ---------------------------------------------------------------------------
# 2. Test SSH par nom (MagicDNS Tailscale)
# ---------------------------------------------------------------------------

$sshByName = Test-SshHost -Host $MachineName -User $SshUser -Label "nom Tailscale ($MachineName)"

if (-not $sshByName) {
    Write-Hint "Tailscale MagicDNS peut mettre quelques minutes a se propager."
    Write-Hint "Verifiez que '$MachineName' apparait dans : tailscale status"
    Write-Hint "Verifiez que MagicDNS est active dans votre admin Tailscale."
    Write-Hint "Si la cle SSH GitHub n'est pas encore propagee, attendez 1 minute."
    Write-Hint "En cas de 'Permission denied (publickey)' : votre cle SSH publique"
    Write-Hint "  doit etre sur https://github.com/$SshUser.keys (ou le GitHubUser configure)."
    Write-Hint "Verifiez aussi que vous utilisez le bon SshUser : '$SshUser'."
}

# ---------------------------------------------------------------------------
# 3. Test SSH par IP Tailscale (optionnel)
# ---------------------------------------------------------------------------

if ($TailscaleIp -ne "") {
    $sshByIp = Test-SshHost -Host $TailscaleIp -User $SshUser -Label "IP Tailscale ($TailscaleIp)"
    if (-not $sshByIp) {
        Write-Hint "Verifiez que l'IP $TailscaleIp est bien celle de $MachineName dans : tailscale status"
        Write-Hint "Si le nom fonctionne mais pas l'IP, c'est probablement un probleme de routage."
    }
}

# ---------------------------------------------------------------------------
# Bilan
# ---------------------------------------------------------------------------

Write-Host ""
Write-Host "------------------------------------------------------------"
if ($sshByName) {
    Write-Host "  SSH operationnel. Vous pouvez debrancher ecran et clavier." -ForegroundColor Green
    Write-Host "  Connexion : ssh $SshUser@$MachineName"
} else {
    Write-Host "  SSH non fonctionnel. Consultez les hints ci-dessus." -ForegroundColor Red
    Write-Host "  Si le probleme persiste, reconnectez ecran/clavier et relancez le bootstrap."
}
Write-Host "------------------------------------------------------------"
Write-Host ""
