# CCRouter session-start hook (Windows/PowerShell)
# Registers with the CCRouter daemon and persists session ID to file.
# Called by Claude Code on SessionStart event.
try {
    $sessionJson = [Console]::In.ReadToEnd()
    $session = $sessionJson | ConvertFrom-Json
    $sessionId = $session.session_id
    $cwd = $session.cwd

    if (-not $sessionId) { exit 0 }

    # Read daemon URL from config (default: localhost for standalone)
    $ccrouterDir = Join-Path ($env:USERPROFILE ?? $env:HOME ?? "/tmp") ".ccrouter"
    $configPath = Join-Path $ccrouterDir "config.json"
    $daemonUrl = "http://127.0.0.1:19919"
    if (Test-Path $configPath) {
        $config = Get-Content $configPath -Raw | ConvertFrom-Json
        if ($config.daemonUrl) { $daemonUrl = $config.daemonUrl }
    }

    # Look up previous session name for this workspace (for re-identification)
    $desiredName = $null
    $sessionsDir = Join-Path $ccrouterDir "last-sessions"
    if ($cwd -and (Test-Path $sessionsDir)) {
        $md5 = [System.Security.Cryptography.MD5]::Create()
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($cwd)
        $hash = ($md5.ComputeHash($bytes) | ForEach-Object { $_.ToString("x2") }) -join ""
        $sessionFile = Join-Path $sessionsDir "$hash.json"
        if (Test-Path $sessionFile) {
            try {
                $savedSessions = Get-Content $sessionFile -Raw | ConvertFrom-Json
                if ($savedSessions.Count -gt 0) {
                    $desiredName = $savedSessions[0].friendlyName
                }
            } catch {}
        }
    }

    # Build payload (no tty on Windows)
    $payload = @{
        session_id = $sessionId
        cwd = $cwd
        pid = $PID
    }
    if ($desiredName) {
        $payload.desired_name = $desiredName
    }
    $payloadJson = $payload | ConvertTo-Json

    # Register with daemon
    $response = Invoke-RestMethod -Uri "$daemonUrl/register" `
        -Method Post -Body $payloadJson -ContentType "application/json" `
        -TimeoutSec 5 -ErrorAction Stop

    # Persist session ID to file (env vars don't propagate to MCP on Windows)
    New-Item -ItemType Directory -Force -Path $ccrouterDir | Out-Null
    $sessionId | Set-Content (Join-Path $ccrouterDir "session_id") -NoNewline

    $name = $response.friendly_name
    Write-Host "[CCRouter] Session registered as `"$name`". You can use CCRouter tools to communicate with other sessions."
} catch {
    exit 0
}
