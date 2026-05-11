<#
.SYNOPSIS
Bootstrap a fresh Windows 10/11 host into a working mappy-hour deployment
target. Idempotent: re-runnable, skips already-done steps via a state
file at $env:ProgramData\MappyHour\bootstrap-state.json.

.DESCRIPTION
This is the from-scratch counterpart of docs/deploy.md. It does
everything that can be scripted:

  - Enables WSL2 + VirtualMachinePlatform Windows features (one reboot)
  - Installs the WSL2 kernel + Ubuntu (web-download path, no Store)
  - Installs Git if missing and clones the repo to $RepoPath
  - Configures /etc/wsl.conf (systemd) and kiosque .wslconfig
  - Installs Docker Engine in WSL via scripts/headless-server-selfhosting/install-docker.sh
  - Creates the Mappy-WSL-Keepalive scheduled task (kiosque @ logon)
  - Adds $KiosqueUser to sshd_config AllowUsers (backup + sshd -t validation)
  - Installs the CI deploy public key into administrators_authorized_keys
  - Writes .env with MAPPY_ATLAS_PATH pointing at the host atlas
  - Optionally patches the Tailscale ACL (tag:ci to tagOwners) via API
  - Optionally pushes GHA secrets (OAuth + SSH host info) via gh CLI + PAT
  - Pulls + starts the container as a smoke test

What it does NOT do (manual steps remaining):

  - Create the Tailscale OAuth client (no public API; the script prints
    the URL, scope requirements, and tries to open the browser)
  - Provision the kiosque Windows user (must exist with auto-login enabled)
  - Initial 'tailscale up' on mitch and 'tailscale funnel 443 on'
  - Download/seed the atlas data into C:\mappy-data\cache\sunlight

.PARAMETER TailscaleOAuthClientId
OAuth client ID from the Tailscale admin console. Required for unattended
runs; otherwise the script prompts.

.PARAMETER TailscaleOAuthSecret
OAuth client secret (tskey-client-...). Required for unattended runs.

.PARAMETER TailscaleApiToken
Admin API access token (tskey-api-...) used to patch the tailnet ACL.
Optional — if omitted, the ACL step is skipped.

.PARAMETER GitHubPat
GitHub Personal Access Token with `repo` scope. Used to upload the
TS_OAUTH_CLIENT_ID/SECRET and MITCH_SSH_* secrets via gh CLI. Optional.

.PARAMETER GitHubRepo
Repo slug (owner/name). Defaults to salfab/mappy-hour.

.PARAMETER TailnetName
Tailscale tailnet name (e.g. salfab.github). Defaults to salfab.github.

.PARAMETER KiosqueUser
The auto-logged-in Windows user that hosts WSL2/Docker. Defaults to "kiosque".

.PARAMETER AtlasDataPath
Host path where the atlas cache lives. Defaults to C:\mappy-data.

.PARAMETER RepoPath
Where to clone the repo on mitch. Defaults to C:\srv\mappy-hour.

.PARAMETER RepoUrl
Clone URL. Defaults to https://github.com/salfab/mappy-hour.git.

.PARAMETER SshPublicKey
The CI deploy public key (single line). If omitted, the script prompts.

.PARAMETER SkipReboot
Don't reboot after enabling WSL2 features — print a message and exit.

.EXAMPLE
.\mitch-bootstrap.ps1 -TailscaleOAuthClientId xxx -TailscaleOAuthSecret yyy `
    -TailscaleApiToken tskey-api-... -GitHubPat ghp_... `
    -SshPublicKey "ssh-ed25519 AAAA... github-actions-deploy"

.NOTES
Run from an elevated PowerShell session as an administrator user
(typically `devops`). Re-run after the reboot to continue past phase 1.

Standalone download (when the repo is not yet cloned):
  iwr https://raw.githubusercontent.com/salfab/mappy-hour/master/scripts/deploy/mitch-bootstrap.ps1 -OutFile bootstrap.ps1
#>

[CmdletBinding()]
param(
    [string]$TailscaleOAuthClientId,
    [string]$TailscaleOAuthSecret,
    [string]$TailscaleApiToken,
    [string]$GitHubPat,
    [string]$GitHubRepo = 'salfab/mappy-hour',
    [string]$TailnetName = 'salfab.github',
    [string]$KiosqueUser = 'kiosque',
    [string]$AtlasDataPath = 'C:\mappy-data',
    [string]$RepoPath = 'C:\srv\mappy-hour',
    [string]$RepoUrl = 'https://github.com/salfab/mappy-hour.git',
    [string]$SshPublicKey,
    [switch]$SkipReboot
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# State management ----------------------------------------------------------
$StateDir = Join-Path $env:ProgramData 'MappyHour'
$StateFile = Join-Path $StateDir 'bootstrap-state.json'
if (-not (Test-Path $StateDir)) { New-Item -ItemType Directory -Path $StateDir -Force | Out-Null }
$State = if (Test-Path $StateFile) { Get-Content $StateFile -Raw | ConvertFrom-Json } else { [PSCustomObject]@{} }

function Save-State { $script:State | ConvertTo-Json | Set-Content -Path $StateFile -Encoding ASCII }
function Step-Done($name) { $script:State | Add-Member -NotePropertyName $name -NotePropertyValue $true -Force; Save-State }
function Step-Pending($name) { -not ($script:State.PSObject.Properties.Name -contains $name -and $script:State.$name) }
function To-Wsl($p) { ('/mnt/' + $p.Substring(0,1).ToLower() + $p.Substring(2).Replace('\','/')) }

function Log($msg) { Write-Host ('=== ' + $msg + ' ===') -ForegroundColor Cyan }
function Info($msg) { Write-Host ('    ' + $msg) }
function Warn($msg) { Write-Host ('    WARN: ' + $msg) -ForegroundColor Yellow }
function Die($msg) { Write-Host ('    ERROR: ' + $msg) -ForegroundColor Red; exit 1 }

# Preflight -----------------------------------------------------------------
Log 'Preflight'
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Die 'This script must be run as Administrator. Right-click PowerShell -> Run as administrator.'
}
$winVer = [Environment]::OSVersion.Version
Info ("Windows {0}.{1}.{2}" -f $winVer.Major, $winVer.Minor, $winVer.Build)

Info "Running as: $(([Security.Principal.WindowsIdentity]::GetCurrent()).Name)"
if (-not (Get-LocalUser -Name $KiosqueUser -ErrorAction SilentlyContinue)) {
    Die "Local user '$KiosqueUser' does not exist. Create it (with auto-login enabled) before running."
}

# Phase 0: OAuth + PAT inputs ----------------------------------------------
if (-not $TailscaleOAuthClientId -or -not $TailscaleOAuthSecret) {
    Log 'Tailscale OAuth client'
    $url = 'https://login.tailscale.com/admin/settings/oauth'
    Info 'Open this URL on a machine with a browser:'
    Info "  $url"
    Info ''
    Info 'Create a new OAuth client with:'
    Info '  - Scopes: Devices > Core (Write)  AND  Auth Keys (Write)  [BOTH required]'
    Info "  - Tags: tag:ci   (must also exist in your ACL's tagOwners)"
    Info ''
    try { Start-Process $url -ErrorAction SilentlyContinue; Info '(Browser launched if available on this host.)' } catch {}
    if (-not $TailscaleOAuthClientId) { $TailscaleOAuthClientId = Read-Host 'Paste Client ID' }
    if (-not $TailscaleOAuthSecret) { $TailscaleOAuthSecret = Read-Host 'Paste Client Secret (tskey-client-...)' }
}

# Phase 1: enable WSL2 features ---------------------------------------------
Log 'Phase 1 — WSL2 + VirtualMachinePlatform features'
$wslState = (Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Windows-Subsystem-Linux).State
$vmpState = (Get-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform).State
Info "WSL: $wslState | VMP: $vmpState"

$needsReboot = $false
if ($wslState -ne 'Enabled') { Info 'Enabling Microsoft-Windows-Subsystem-Linux...'; & dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart | Out-Null; $needsReboot = $true }
if ($vmpState -ne 'Enabled') { Info 'Enabling VirtualMachinePlatform...'; & dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart | Out-Null; $needsReboot = $true }
if ($needsReboot -and -not $State.RebootedAfterFeatures) {
    $State | Add-Member -NotePropertyName 'RebootedAfterFeatures' -NotePropertyValue $false -Force
    Save-State
    if ($SkipReboot) { Warn 'SkipReboot set — reboot manually, then re-run with the same args.'; exit 0 }
    Info 'Rebooting in 10s. Re-run this script with the same args after Windows is back.'
    Start-Sleep 10
    Restart-Computer -Force
    exit 0
}
$State | Add-Member -NotePropertyName 'RebootedAfterFeatures' -NotePropertyValue $true -Force; Save-State

# Phase 2: Git + repo clone (needed before Docker install) -----------------
Log 'Phase 2 — Git + repo clone'
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { Die 'Git is missing and winget is not available. Install Git for Windows manually and re-run.' }
    Info 'Installing Git via winget...'
    & winget install -e --id Git.Git --accept-source-agreements --accept-package-agreements
    # Refresh PATH for current session
    $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
}
if (Step-Pending 'RepoCloned') {
    if (-not (Test-Path "$RepoPath\.git")) {
        New-Item -ItemType Directory -Path (Split-Path $RepoPath -Parent) -Force | Out-Null
        & git clone $RepoUrl $RepoPath
        if ($LASTEXITCODE -ne 0) { Die "git clone failed: $RepoUrl" }
    } else { Info "Repo already cloned at $RepoPath" }
    Step-Done 'RepoCloned'
}

# Phase 3: WSL kernel + Ubuntu ----------------------------------------------
Log 'Phase 3 — WSL kernel + Ubuntu'
if (Step-Pending 'WslKernelUpdated') {
    Info 'wsl --update --web-download (avoids Microsoft Store dependency)...'
    & wsl --update --web-download 2>&1 | Out-Null
    & wsl --set-default-version 2 2>&1 | Out-Null
    Step-Done 'WslKernelUpdated'
}
if (Step-Pending 'UbuntuInstalled') {
    Info 'wsl --install -d Ubuntu --no-launch --web-download...'
    & wsl --install -d Ubuntu --no-launch --web-download 2>&1 | Out-Null
    & wsl -d Ubuntu -u root -e bash -c 'echo init ok' | Out-Null
    Step-Done 'UbuntuInstalled'
}

# Phase 4: /etc/wsl.conf with systemd ---------------------------------------
Log 'Phase 4 — /etc/wsl.conf (systemd=true, root default)'
if (Step-Pending 'WslConfApplied') {
    $confTmp = Join-Path $env:TEMP 'mappy-wsl.conf'
    @"
[boot]
systemd=true

[user]
default = root
"@ | Set-Content -Path $confTmp -Encoding ASCII -NoNewline
    $confTmpWsl = To-Wsl $confTmp
    & wsl -d Ubuntu -u root -e bash -c "cp '$confTmpWsl' /etc/wsl.conf && cat /etc/wsl.conf" | Out-Host
    & wsl --shutdown
    Start-Sleep 5
    & wsl -d Ubuntu -u root -e bash -c 'systemctl is-system-running 2>&1 | head -1' | Out-Host
    Step-Done 'WslConfApplied'
}

# Phase 5: Docker Engine (uses cloned repo's install-docker.sh) ------------
Log 'Phase 5 — Docker Engine in WSL'
if (Step-Pending 'DockerInstalled') {
    $installer = Join-Path $RepoPath 'scripts\headless-server-selfhosting\install-docker.sh'
    if (-not (Test-Path $installer)) { Die "install-docker.sh not found at $installer — repo clone phase didn't complete?" }
    $installerWsl = To-Wsl $installer
    & wsl -d Ubuntu -u root -e bash $installerWsl | Out-Host
    Step-Done 'DockerInstalled'
}

# Phase 6: .wslconfig for kiosque (the user where WSL must persist) --------
Log 'Phase 6 — .wslconfig for kiosque (vmIdleTimeout=-1)'
if (Step-Pending 'KiosqueWslConfig') {
    $kiosqueWslConfig = "C:\Users\$KiosqueUser\.wslconfig"
    @"
[wsl2]
vmIdleTimeout=-1
[experimental]
autoMemoryReclaim=gradual
"@ | Set-Content -Path $kiosqueWslConfig -Encoding ASCII -NoNewline
    & icacls $kiosqueWslConfig /grant "${KiosqueUser}:R" /grant 'Administrators:F' | Out-Null
    Info "Wrote $kiosqueWslConfig"
    Step-Done 'KiosqueWslConfig'
}

# Phase 7: scheduled task that keeps kiosque's WSL alive at logon ----------
Log 'Phase 7 — Mappy-WSL-Keepalive scheduled task'
if (Step-Pending 'KeepaliveTask') {
    $taskName = 'Mappy-WSL-Keepalive'
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    $action = New-ScheduledTaskAction -Execute 'wsl.exe' -Argument '-d Ubuntu -u root --exec /usr/bin/sleep infinity'
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:COMPUTERNAME\$KiosqueUser"
    $principal = New-ScheduledTaskPrincipal -UserId "$env:COMPUTERNAME\$KiosqueUser" -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 99 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Keep WSL Ubuntu alive in kiosque session for Docker container persistence' | Out-Null
    Info "Registered $taskName (runs at kiosque logon, sleep infinity holds the VM up)"
    Step-Done 'KeepaliveTask'
}

# Phase 8: sshd_config AllowUsers + restart --------------------------------
Log 'Phase 8 — sshd_config AllowUsers'
if (Step-Pending 'SshAllowUsers') {
    $sshd = 'C:\ProgramData\ssh\sshd_config'
    if (-not (Test-Path $sshd)) { Warn 'OpenSSH server not installed — skipping AllowUsers edit.' }
    else {
        $backup = "$sshd.bak.$(Get-Date -Format yyyyMMdd-HHmmss)"
        Copy-Item -Path $sshd -Destination $backup -Force
        Info "Backed up to $backup"
        $cfg = Get-Content $sshd -Raw
        if ($cfg -match "(?m)^AllowUsers\s+.*\b$KiosqueUser\b") { Info "$KiosqueUser already in AllowUsers" }
        elseif ($cfg -match "(?m)^AllowUsers\s+(\S+)") {
            $existing = $matches[1]
            $new = $cfg -replace "(?m)^AllowUsers\s+$existing", "AllowUsers $existing $KiosqueUser"
            Set-Content -Path $sshd -Value $new -NoNewline -Encoding ASCII
            Info "Added $KiosqueUser to AllowUsers (was: $existing)"
        } else { Warn 'No AllowUsers directive found — assuming all admin users allowed.' }
        & 'C:\Windows\System32\OpenSSH\sshd.exe' -t -f $sshd
        if ($LASTEXITCODE -ne 0) { Copy-Item -Path $backup -Destination $sshd -Force; Die 'sshd -t validation failed — restored backup.' }
        Restart-Service sshd
        Info 'sshd restarted'
    }
    Step-Done 'SshAllowUsers'
}

# Phase 9: CI deploy SSH key into administrators_authorized_keys -----------
Log 'Phase 9 — CI deploy SSH key'
if (Step-Pending 'SshDeployKey') {
    if (-not $SshPublicKey) { $SshPublicKey = Read-Host 'Paste CI deploy public key ("ssh-ed25519 AAAA... github-actions-deploy")' }
    $authFile = 'C:\ProgramData\ssh\administrators_authorized_keys'
    $existing = if (Test-Path $authFile) { Get-Content $authFile -Raw } else { '' }
    $pubBody = ($SshPublicKey -split ' ')[1]
    if ($existing -like "*$pubBody*") { Info 'Key already present.' }
    else {
        Add-Content -Path $authFile -Value $SshPublicKey -Encoding ASCII
        & icacls $authFile /inheritance:r /grant 'SYSTEM:F' /grant 'Administrators:F' | Out-Null
        Info "Appended key to $authFile"
    }
    Step-Done 'SshDeployKey'
}

# Phase 10: .env (MAPPY_ATLAS_PATH) ----------------------------------------
Log 'Phase 10 — .env file'
if (Step-Pending 'EnvFile') {
    $envPath = Join-Path $RepoPath '.env'
    $atlasCacheWsl = To-Wsl (Join-Path $AtlasDataPath 'cache\sunlight')
    Set-Content -Path $envPath -Value "MAPPY_ATLAS_PATH=$atlasCacheWsl" -Encoding ASCII
    Info "Wrote $envPath (MAPPY_ATLAS_PATH=$atlasCacheWsl)"
    Step-Done 'EnvFile'
}

# Phase 11: atlas data directory -------------------------------------------
Log 'Phase 11 — atlas data directory'
$atlasCacheDir = Join-Path $AtlasDataPath 'cache\sunlight'
if (-not (Test-Path $atlasCacheDir)) {
    New-Item -ItemType Directory -Path $atlasCacheDir -Force | Out-Null
    Info "Created empty $atlasCacheDir"
    Warn 'Atlas not seeded by this script. Use atlas-loader or copy from a known good source.'
}

# Phase 12: Tailscale ACL patch via API token (idempotent) -----------------
Log 'Phase 12 — Tailscale ACL (tag:ci in tagOwners)'
if ($TailscaleApiToken) {
    $aclScript = Join-Path $RepoPath 'scripts\deploy\setup-tailscale-ci-acl.sh'
    if (Test-Path $aclScript) {
        $aclScriptWsl = To-Wsl $aclScript
        & wsl -d Ubuntu -u root -e bash -c "TS_API_TOKEN='$TailscaleApiToken' bash '$aclScriptWsl' '$TailnetName'" | Out-Host
    } else { Warn "setup-tailscale-ci-acl.sh not found at $aclScript — patch ACL manually." }
} else { Warn 'TailscaleApiToken not provided — skipping ACL patch.' }

# Phase 13: GitHub Actions secrets via gh + PAT ----------------------------
Log 'Phase 13 — GitHub Actions secrets'
if ($GitHubPat) {
    if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
        Info 'gh CLI missing — installing via winget...'
        & winget install -e --id GitHub.cli --accept-source-agreements --accept-package-agreements
        $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
    }
    if (Get-Command gh -ErrorAction SilentlyContinue) {
        $env:GH_TOKEN = $GitHubPat
        $hostname = $env:COMPUTERNAME.ToLower()
        $hostKey = & ssh-keyscan -t ed25519 $hostname 2>$null
        $secrets = [ordered]@{
            'TS_OAUTH_CLIENT_ID'     = $TailscaleOAuthClientId
            'TS_OAUTH_CLIENT_SECRET' = $TailscaleOAuthSecret
            'MITCH_SSH_HOST'         = $hostname
            'MITCH_SSH_USER'         = $KiosqueUser
            'MITCH_KNOWN_HOSTS'      = $hostKey
        }
        foreach ($k in $secrets.Keys) {
            if ($secrets[$k]) {
                $secrets[$k] | & gh secret set $k --repo $GitHubRepo
                Info "Set secret $k"
            } else { Warn "Skipping $k (empty value)" }
        }
        Warn 'MITCH_SSH_KEY (the private half of the CI deploy key) must still be set manually:'
        Warn "  gh secret set MITCH_SSH_KEY --repo $GitHubRepo < path-to-private-key.pem"
    }
} else { Warn 'GitHubPat not provided — set the GHA secrets manually (cf. docs/deploy.md §5.3).' }

# Phase 14: smoke test -----------------------------------------------------
Log 'Phase 14 — smoke test'
Info 'Triggering the keepalive task and running docker compose up...'
Start-ScheduledTask -TaskName 'Mappy-WSL-Keepalive' -ErrorAction SilentlyContinue
Start-Sleep 5
& wsl -d Ubuntu -u root -e bash -c "cd '$(To-Wsl $RepoPath)' && docker compose pull && docker compose up -d" | Out-Host
Start-Sleep 15
try {
    $r = Invoke-WebRequest 'http://127.0.0.1:3000/api/datasets' -UseBasicParsing -TimeoutSec 10
    Info "OK: HTTP $($r.StatusCode)"
} catch {
    Warn "Local /api/datasets check failed: $($_.Exception.Message)"
    Warn 'Check `wsl -d Ubuntu docker logs mappy-hour` and `tailscale serve status`.'
}

Log 'Bootstrap complete'
Info "State file: $StateFile (delete to force re-run from scratch)"
Info ''
Info 'Manual steps still required:'
Info "  1. Configure auto-logon for $KiosqueUser (Windows Settings, or Microsoft Autologon)"
Info '  2. tailscale up  (interactive once, to register mitch in your tailnet)'
Info '  3. tailscale serve --bg --https=443 http://localhost:3000  &&  tailscale funnel 443 on'
Info "  4. Seed atlas data into $atlasCacheDir (atlas-loader or scp)"
Info '  5. Verify https://<hostname>.<tailnet>.ts.net/api/datasets returns 200'
