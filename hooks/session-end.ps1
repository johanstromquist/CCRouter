# CCRouter session-end hook (Windows/PowerShell)
# Deregisters from the CCRouter daemon.
try {
    $sessionJson = [Console]::In.ReadToEnd()
    $session = $sessionJson | ConvertFrom-Json
    $sessionId = $session.session_id

    if (-not $sessionId) { exit 0 }

    $configPath = Join-Path ($env:USERPROFILE ?? $env:HOME ?? "/tmp") ".ccrouter/config.json"
    $daemonUrl = "http://127.0.0.1:19919"
    if (Test-Path $configPath) {
        $config = Get-Content $configPath -Raw | ConvertFrom-Json
        if ($config.daemonUrl) { $daemonUrl = $config.daemonUrl }
    }

    $payload = @{ session_id = $sessionId } | ConvertTo-Json
    Invoke-RestMethod -Uri "$daemonUrl/deregister" `
        -Method Post -Body $payload -ContentType "application/json" `
        -TimeoutSec 2 -ErrorAction SilentlyContinue | Out-Null
} catch {
    exit 0
}
