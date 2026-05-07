# remote-server-preflight.ps1
#
# A copier sur le serveur headless via SCP, puis executer via SSH.
# Produit un rapport d'etat de la machine. Ne modifie rien.
#
# Depuis la machine de dev :
#   scp .\remote-server-preflight.ps1 devops@petbox:C:/sources/mappy-hour/remote-server-preflight.ps1
#   ssh devops@petbox "powershell -ExecutionPolicy Bypass -File C:\sources\mappy-hour\remote-server-preflight.ps1"

#Requires -Version 5.1
Set-StrictMode -Version Latest
$ErrorActionPreference = "SilentlyContinue"

# ---------------------------------------------------------------------------
# Fonctions utilitaires
# ---------------------------------------------------------------------------

function Write-Section {
    param([string]$Title)
    Write-Host ""
    Write-Host "=== $Title ===" -ForegroundColor Cyan
}

function Write-Row {
    param([string]$Label, [string]$Value, [string]$Status = "")
    $line = "  {0,-30} {1}" -f $Label, $Value
    if ($Status -eq "ok")   { Write-Host $line -ForegroundColor Green  }
    elseif ($Status -eq "warn") { Write-Host $line -ForegroundColor Yellow }
    elseif ($Status -eq "ko")   { Write-Host $line -ForegroundColor Red    }
    else                        { Write-Host $line }
}

function Get-ServiceStatus {
    param([string]$Name)
    $svc = Get-Service -Name $Name -ErrorAction SilentlyContinue
    if ($null -eq $svc) { return "introuvable" }
    return $svc.Status.ToString()
}

function Find-Exe {
    param([string]$Name)
    $found = Get-Command $Name -ErrorAction SilentlyContinue
    if ($found) { return $found.Source }
    return $null
}

# ---------------------------------------------------------------------------
# En-tete
# ---------------------------------------------------------------------------

Write-Host ""
Write-Host "============================================================"
Write-Host "  MappyHour — Preflight serveur headless"
Write-Host "  $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Write-Host "============================================================"

# ---------------------------------------------------------------------------
# Identite de la machine
# ---------------------------------------------------------------------------

Write-Section "Machine"
Write-Row "Hostname"         $env:COMPUTERNAME
Write-Row "Utilisateur"      "$env:USERDOMAIN\$env:USERNAME"
Write-Row "PowerShell"       $PSVersionTable.PSVersion.ToString()
Write-Row "Windows"          ([System.Environment]::OSVersion.VersionString)

# ---------------------------------------------------------------------------
# Tailscale
# ---------------------------------------------------------------------------

Write-Section "Tailscale"

$tailscaleExe = Find-Exe "tailscale.exe"
if ($null -eq $tailscaleExe) {
    # Chemin d'installation classique
    $defaultPath = "C:\Program Files\Tailscale\tailscale.exe"
    if (Test-Path $defaultPath) { $tailscaleExe = $defaultPath }
}

if ($null -ne $tailscaleExe) {
    Write-Row "Executable" $tailscaleExe "ok"
    $tsStatus = & $tailscaleExe status --json 2>&1
    if ($LASTEXITCODE -eq 0) {
        try {
            $tsJson = $tsStatus | ConvertFrom-Json
            $selfIp = ($tsJson.TailscaleIPs | Select-Object -First 1)
            Write-Row "Statut"    "connecte" "ok"
            Write-Row "IP Tailscale" ($selfIp ?? "(inconnue)")
        } catch {
            Write-Row "Statut" "connecte (parse JSON echoue)" "warn"
        }
    } else {
        Write-Row "Statut" "non connecte ou erreur" "warn"
    }
} else {
    Write-Row "Tailscale" "non installe" "warn"
}

# ---------------------------------------------------------------------------
# OpenSSH
# ---------------------------------------------------------------------------

Write-Section "OpenSSH"

$sshdStatus = Get-ServiceStatus "sshd"
$statusLabel = if ($sshdStatus -eq "Running") { "ok" } elseif ($sshdStatus -eq "introuvable") { "ko" } else { "warn" }
Write-Row "Service sshd" $sshdStatus $statusLabel

$fwRules = Get-NetFirewallRule -DisplayName "*SSH*" -ErrorAction SilentlyContinue
if ($null -ne $fwRules -and $fwRules.Count -gt 0) {
    foreach ($rule in $fwRules) {
        $ruleStatus = if ($rule.Enabled -eq "True") { "ok" } else { "warn" }
        Write-Row "Regle pare-feu: $($rule.DisplayName)" $rule.Action $ruleStatus
    }
} else {
    Write-Row "Regles pare-feu SSH" "aucune trouvee" "warn"
}

# ---------------------------------------------------------------------------
# Espace disque
# ---------------------------------------------------------------------------

Write-Section "Espace disque"

$drives = Get-PSDrive -PSProvider FileSystem -ErrorAction SilentlyContinue
foreach ($drive in $drives) {
    if ($null -ne $drive.Used -and $null -ne $drive.Free) {
        $totalGB = [math]::Round(($drive.Used + $drive.Free) / 1GB, 1)
        $freeGB  = [math]::Round($drive.Free / 1GB, 1)
        $pctFree = if ($totalGB -gt 0) { [math]::Round($freeGB / $totalGB * 100) } else { 0 }
        $diskStatus = if ($pctFree -lt 10) { "ko" } elseif ($pctFree -lt 20) { "warn" } else { "ok" }
        Write-Row "$($drive.Name):\" "$freeGB GB libres / $totalGB GB ($pctFree% libre)" $diskStatus
    }
}

# ---------------------------------------------------------------------------
# Docker
# ---------------------------------------------------------------------------

Write-Section "Docker"

$dockerExe = Find-Exe "docker.exe"
if ($null -ne $dockerExe) {
    Write-Row "docker CLI" $dockerExe "ok"
    $dockerVer = & docker.exe version --format "{{.Client.Version}}" 2>&1
    Write-Row "Version client" ($dockerVer -join "")
    $dockerInfo = & docker.exe info 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Row "Docker daemon" "accessible" "ok"
    } else {
        Write-Row "Docker daemon" "non accessible (daemon arrete ?)" "warn"
    }
} else {
    Write-Row "docker CLI" "non installe" "warn"
}

$composeExe = Find-Exe "docker-compose.exe"
$composePlugin = & docker.exe compose version 2>&1
if ($LASTEXITCODE -eq 0) {
    Write-Row "docker compose (plugin)" ($composePlugin -join "") "ok"
} elseif ($null -ne $composeExe) {
    Write-Row "docker-compose (legacy)" $composeExe "warn"
} else {
    Write-Row "docker compose" "non installe" "warn"
}

$dockerDesktopPath = "C:\Program Files\Docker\Docker\Docker Desktop.exe"
if (Test-Path $dockerDesktopPath) {
    Write-Row "Docker Desktop" "installe" "ok"
} else {
    Write-Row "Docker Desktop" "non installe (optionnel sur serveur)" ""
}

# ---------------------------------------------------------------------------
# Pied de page
# ---------------------------------------------------------------------------

Write-Host ""
Write-Host "============================================================"
Write-Host "  Fin du preflight."
Write-Host "  Les elements marques [warn] ou [KO] sont a traiter"
Write-Host "  avant le deploiement de l'application."
Write-Host "============================================================"
Write-Host ""
