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
    $ccrouterDir = Join-Path ($env:USERPROFILE ?? $env:HOME ?? "/tmp") ".ccrouter"
    $configPath = Join-Path $ccrouterDir "config.json"
    $daemonUrl = "http://127.0.0.1:19919"
    if (Test-Path $configPath) {
        $config = Get-Content $configPath -Raw | ConvertFrom-Json
        if ($config.daemonUrl) { $daemonUrl = $config.daemonUrl }
    }

    # The CC process PID is our direct parent.
    # The MCP server is also a child of CC, sharing the same parent PID.
    $ccPid = (Get-Process -Id $PID).Parent.Id

    # Build payload
    $payload = @{
        session_id = $sessionId
        cwd = $cwd
        pid = $ccPid
    } | ConvertTo-Json

    # Register with daemon
    $response = Invoke-RestMethod -Uri "$daemonUrl/register" `
        -Method Post -Body $payload -ContentType "application/json" `
        -TimeoutSec 5 -ErrorAction Stop

    $name = $response.friendly_name

    # Bind the MCP server to this session
    $mcpUrl = "http://127.0.0.1:19920"
    try {
        Invoke-RestMethod -Uri "$mcpUrl/bind" -Method Post `
            -Body (@{session_id=$sessionId} | ConvertTo-Json) `
            -ContentType "application/json" -TimeoutSec 2 -ErrorAction SilentlyContinue | Out-Null
    } catch {}

    Write-Host "[CCRouter] Session registered as `"$name`". You can use CCRouter tools to communicate with other sessions."
} catch {
    exit 0
}
