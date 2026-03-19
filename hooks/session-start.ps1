# CCRouter session-start hook (Windows/PowerShell)
# Registers with the CCRouter daemon and persists session ID to file.
# Called by Claude Code on SessionStart event.
try {
    $sessionJson = [Console]::In.ReadToEnd()
    $session = $sessionJson | ConvertFrom-Json
    $sessionId = $session.session_id
    # Normalize path separators so cwd hashes match across sessions
    $cwd = ($session.cwd -replace '\\', '/')

    if (-not $sessionId) { exit 0 }

    # Read daemon URL from config (default: localhost for standalone)
    $ccrouterDir = Join-Path ($env:USERPROFILE ?? $env:HOME ?? "/tmp") ".ccrouter"
    $configPath = Join-Path $ccrouterDir "config.json"
    $daemonUrl = "http://127.0.0.1:19919"
    if (Test-Path $configPath) {
        $config = Get-Content $configPath -Raw | ConvertFrom-Json
        if ($config.daemonUrl) { $daemonUrl = $config.daemonUrl }
    }

    # desired_name is intentionally NOT read from last-sessions here.
    # In multi-terminal workspaces, all terminals share the same cwd hash,
    # so reading sessions[0] would give every terminal the same name.
    # Use 'claude-r' for named session recovery instead.
    $desiredName = $null

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
