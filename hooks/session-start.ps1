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
    $configPath = Join-Path ($env:USERPROFILE ?? $env:HOME ?? "/tmp") ".ccrouter/config.json"
    $daemonUrl = "http://127.0.0.1:19919"
    if (Test-Path $configPath) {
        $config = Get-Content $configPath -Raw | ConvertFrom-Json
        if ($config.daemonUrl) { $daemonUrl = $config.daemonUrl }
    }

    # Register with daemon (no tty on Windows)
    $payload = @{
        session_id = $sessionId
        cwd = $cwd
        pid = $PID
    } | ConvertTo-Json

    $response = Invoke-RestMethod -Uri "$daemonUrl/register" `
        -Method Post -Body $payload -ContentType "application/json" `
        -TimeoutSec 5 -ErrorAction Stop

    # Persist session ID to file (env vars don't propagate to MCP on Windows)
    $ccrouterDir = Join-Path ($env:USERPROFILE ?? $env:HOME ?? "/tmp") ".ccrouter"
    New-Item -ItemType Directory -Force -Path $ccrouterDir | Out-Null
    $sessionId | Set-Content (Join-Path $ccrouterDir "session_id") -NoNewline

    $name = $response.friendly_name
    Write-Host "[CCRouter] Session registered as `"$name`". You can use CCRouter tools to communicate with other sessions."
} catch {
    exit 0
}
