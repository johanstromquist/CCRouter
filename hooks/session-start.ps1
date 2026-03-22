# CCRouter session-start hook (Windows/PowerShell)
# Registers with the CCRouter daemon.
# Called by Claude Code on SessionStart event.
try {
    $sessionJson = [Console]::In.ReadToEnd()
    $session = $sessionJson | ConvertFrom-Json
    $sessionId = $session.session_id
    # Normalize path separators so cwd hashes match across sessions
    $cwd = ($session.cwd -replace '\\', '/')

    if (-not $sessionId) { exit 0 }

    # Read daemon URL from config (default: localhost for standalone)
    $homeDir = if ($env:USERPROFILE) { $env:USERPROFILE } elseif ($env:HOME) { $env:HOME } else { "/tmp" }
    $ccrouterDir = Join-Path $homeDir ".ccrouter"
    $configPath = Join-Path $ccrouterDir "config.json"
    $daemonUrl = "http://127.0.0.1:19919"
    if (Test-Path $configPath) {
        $config = Get-Content $configPath -Raw | ConvertFrom-Json
        if ($config.daemonUrl) { $daemonUrl = $config.daemonUrl }
    }

    # The CC process PID is our direct parent.
    # Used for PID liveness checking during stale session cleanup.
    # (Get-Process).Parent requires PS 7+; use WMI for PS 5.1 compat)
    $ccPid = (Get-CimInstance Win32_Process -Filter "ProcessId=$PID" -ErrorAction SilentlyContinue).ParentProcessId

    # Walk up from this script to find the terminal shell PID.
    # The terminal shell is the process whose parent is Cursor/VS Code.
    # Single CIM query to get all ancestors at once (fast).
    $terminalPid = $null
    try {
        $walkPid = [int]$PID
        $allProcs = @{}
        Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name -ErrorAction SilentlyContinue | ForEach-Object {
            $allProcs[[int]$_.ProcessId] = $_
        }
        for ($i = 0; $i -lt 15; $i++) {
            if (-not $allProcs.ContainsKey($walkPid)) { break }
            $proc = $allProcs[$walkPid]
            $parentId = [int]$proc.ParentProcessId
            if ($allProcs.ContainsKey($parentId)) {
                $parentName = $allProcs[$parentId].Name
                if ($parentName -match '(Cursor|Code)(\.exe)?$') {
                    $terminalPid = $walkPid
                    break
                }
            }
            $walkPid = $parentId
            if ($walkPid -le 1) { break }
        }
    } catch { }

    # Build payload
    $payload = @{
        session_id = $sessionId
        cwd = $cwd
        pid = $ccPid
    }
    if ($terminalPid) { $payload.terminal_pid = $terminalPid }
    $payload = $payload | ConvertTo-Json -Depth 3

    # Register with daemon
    $response = Invoke-RestMethod -Uri "$daemonUrl/register" `
        -Method Post -Body $payload -ContentType "application/json" `
        -TimeoutSec 5 -ErrorAction Stop

    $name = $response.friendly_name

    Write-Host "[CCRouter] Session registered as `"$name`". You can use CCRouter tools to communicate with other sessions."
} catch {
    exit 0
}
