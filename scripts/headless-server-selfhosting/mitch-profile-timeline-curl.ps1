param(
    [string]$Url = "http://127.0.0.1:3000/api/sunlight/timeline/stream?minLon=6.62&minLat=46.515&maxLon=6.625&maxLat=46.52&date=2026-05-10&timezone=Europe%2FZurich&startLocalTime=08:00&endLocalTime=12:00&sampleEveryMinutes=15&gridStepMeters=1&cacheOnly=true&maxComputeTiles=0",
    [int]$Port = 3000,
    [int]$SampleMs = 250,
    [string]$OutDir = "$env:TEMP\mappy-hour-profile"
)

$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

function Get-ListenPid([int]$Port) {
    $line = netstat -ano | Select-String ":$Port " | Where-Object { $_ -match "LISTENING" } | Select-Object -First 1
    if (-not $line) { throw "No LISTENING process found on port $Port" }
    $pidText = (($line.ToString() -split "\s+") | Where-Object { $_ })[-1]
    return [int]$pidText
}

function Read-TextFileFlexible([string]$Path) {
    if (-not (Test-Path $Path)) { return "" }
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
    try {
        $bytes = New-Object byte[] $stream.Length
        [void]$stream.Read($bytes, 0, $bytes.Length)
    } finally {
        $stream.Dispose()
    }
    if ($bytes.Length -eq 0) { return "" }
    if ($bytes.Length -ge 2 -and $bytes[0] -eq 0xFF -and $bytes[1] -eq 0xFE) {
        return [Text.Encoding]::Unicode.GetString($bytes)
    }
    $sampleLength = [Math]::Min($bytes.Length, 200)
    $zeroCount = 0
    for ($i = 0; $i -lt $sampleLength; $i++) {
        if ($bytes[$i] -eq 0) { $zeroCount += 1 }
    }
    if ($zeroCount -gt ($sampleLength / 4)) {
        return [Text.Encoding]::Unicode.GetString($bytes)
    }
    return [Text.Encoding]::UTF8.GetString($bytes)
}

$targetPid = Get-ListenPid $Port
$logicalProcessors = (Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors
if (-not $logicalProcessors -or $logicalProcessors -lt 1) { $logicalProcessors = 1 }

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$responsePath = Join-Path $OutDir "timeline-$timestamp.sse"
$curlMetricsPath = Join-Path $OutDir "timeline-$timestamp.curl.txt"
$cpuCsvPath = Join-Path $OutDir "timeline-$timestamp.cpu.csv"

Write-Host "=== Target ==="
Write-Host "URL: $Url"
Write-Host "Node PID: $targetPid"
Write-Host "Logical processors: $logicalProcessors"
Write-Host "Sample interval: ${SampleMs}ms"
Write-Host ""

$sampler = Start-Job -ArgumentList $targetPid, $SampleMs, $logicalProcessors -ScriptBlock {
    param($TargetPid, $IntervalMs, $LogicalProcessors)

    $previous = Get-Process -Id $TargetPid -ErrorAction Stop
    $previousCpu = 0.0
    if ($null -ne $previous.CPU) { $previousCpu = [double]$previous.CPU }
    $previousTime = Get-Date

    while ($true) {
        Start-Sleep -Milliseconds $IntervalMs
        $process = Get-Process -Id $TargetPid -ErrorAction SilentlyContinue
        if (-not $process) { break }

        $now = Get-Date
        $cpu = 0.0
        if ($null -ne $process.CPU) { $cpu = [double]$process.CPU }
        $elapsedSeconds = ($now - $previousTime).TotalSeconds
        $cpuDeltaSeconds = [Math]::Max(0, $cpu - $previousCpu)
        $oneCorePercent = if ($elapsedSeconds -gt 0) { 100 * $cpuDeltaSeconds / $elapsedSeconds } else { 0 }
        $machinePercent = $oneCorePercent / $LogicalProcessors

        [pscustomobject]@{
            Timestamp = $now.ToString("o")
            CpuSeconds = [Math]::Round($cpu, 3)
            CpuDeltaSeconds = [Math]::Round($cpuDeltaSeconds, 3)
            OneCorePercent = [Math]::Round($oneCorePercent, 1)
            MachinePercent = [Math]::Round($machinePercent, 1)
            WorkingSetMB = [Math]::Round($process.WorkingSet64 / 1MB, 1)
            PrivateMB = [Math]::Round($process.PrivateMemorySize64 / 1MB, 1)
        }

        $previousCpu = $cpu
        $previousTime = $now
    }
}

$sw = [Diagnostics.Stopwatch]::StartNew()
try {
    $curlOutput = & curl.exe -sS -N -o $responsePath -w "http_code=%{http_code}`ntime_total=%{time_total}`nsize_download=%{size_download}`nspeed_download=%{speed_download}`n" $Url
    $curlExit = $LASTEXITCODE
    $curlOutput | Set-Content $curlMetricsPath
} finally {
    $sw.Stop()
    Stop-Job $sampler -ErrorAction SilentlyContinue
}

$samples = Receive-Job $sampler -ErrorAction SilentlyContinue
Remove-Job $sampler -Force -ErrorAction SilentlyContinue
if ($samples) {
    $samples | Export-Csv -NoTypeInformation -Path $cpuCsvPath
}

Write-Host "=== curl ==="
Write-Host "exit_code=$curlExit"
$curlOutput | ForEach-Object { Write-Host $_ }
Write-Host ("wall_clock={0:n3}s" -f $sw.Elapsed.TotalSeconds)
Write-Host "response=$responsePath"
Write-Host ""

Write-Host "=== CPU samples ==="
if ($samples) {
    $avgOneCore = ($samples | Measure-Object OneCorePercent -Average).Average
    $maxOneCore = ($samples | Measure-Object OneCorePercent -Maximum).Maximum
    $avgMachine = ($samples | Measure-Object MachinePercent -Average).Average
    $maxMachine = ($samples | Measure-Object MachinePercent -Maximum).Maximum
    $maxPrivate = ($samples | Measure-Object PrivateMB -Maximum).Maximum
    $maxWorkingSet = ($samples | Measure-Object WorkingSetMB -Maximum).Maximum
    Write-Host ("samples={0} avg_one_core={1:n1}% max_one_core={2:n1}% avg_machine={3:n1}% max_machine={4:n1}% max_private={5:n1}MB max_ws={6:n1}MB" -f $samples.Count, $avgOneCore, $maxOneCore, $avgMachine, $maxMachine, $maxPrivate, $maxWorkingSet)
    Write-Host "cpu_csv=$cpuCsvPath"
} else {
    Write-Host "No CPU samples captured."
}
Write-Host ""

Write-Host "=== SSE summary ==="
if (Test-Path $responsePath) {
    $response = Get-Content -Raw -Path $responsePath
    $events = [regex]::Matches($response, "(?m)^event:\s*(\S+)") | ForEach-Object { $_.Groups[1].Value }
    $events | Group-Object | Sort-Object Name | ForEach-Object {
        Write-Host ("{0}={1}" -f $_.Name, $_.Count)
    }

    $doneMatch = [regex]::Match($response, "(?ms)^event:\s*done\s*\r?\ndata:\s*(\{.*?\})\s*(?:\r?\n){2}")
    if ($doneMatch.Success) {
        try {
            $done = $doneMatch.Groups[1].Value | ConvertFrom-Json
            Write-Host ("done.elapsedMs={0} tilesFromCache={1} tilesComputed={2} warnings={3}" -f $done.stats.elapsedMs, $done.stats.tilesFromCache, $done.stats.tilesComputed, $done.warnings.Count)
        } catch {
            Write-Host "Could not parse done payload: $($_.Exception.Message)"
        }
    }
}
Write-Host ""

Write-Host "=== Server timing logs ==="
$timingLines = @()
$atlasLines = @()
foreach ($path in @("C:\srv\mappy-hour\server.err", "C:\srv\mappy-hour\server.log")) {
    if (Test-Path $path) {
        $text = Read-TextFileFlexible $path
        $timingLines += [regex]::Matches($text, "\[stream:per-tile-timing\][^\r\n]*") | ForEach-Object { $_.Value }
        $atlasLines += [regex]::Matches($text, "\[stream:atlas-load[^\]]*\][^\r\n]*") | ForEach-Object { $_.Value }
        $atlasLines += [regex]::Matches($text, "\[stream:atlas-io\][^\r\n]*") | ForEach-Object { $_.Value }
    }
}
if ($atlasLines.Count -gt 0) {
    Write-Host "-- atlas-load last 12 --"
    $atlasLines | Select-Object -Last 12 | ForEach-Object { Write-Host $_ }
}
if ($timingLines.Count -gt 0) {
    Write-Host "-- per-tile last 5 --"
    $timingLines | Select-Object -Last 5 | ForEach-Object { Write-Host $_ }
} else {
    Write-Host "No [stream:per-tile-timing] line found. Ensure mitch-start.ps1 redirects stderr to server.err and restart the app."
}
