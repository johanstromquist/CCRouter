# CCRouter statusline hook (Windows/PowerShell)
# Shows session name in Claude Code status bar.
# Queries daemon HTTP API instead of sqlite3 (not available on Windows).
try {
    [Console]::In.ReadToEnd() | Out-Null

    $sidFile = Join-Path ($env:USERPROFILE ?? $env:HOME ?? "/tmp") ".ccrouter/session_id"
    $ts = Get-Date -Format "HH:mm:ss"

    if (-not (Test-Path $sidFile)) {
        Write-Host "CCRouter: ? | $ts"
        exit 0
    }

    $sessionId = (Get-Content $sidFile -Raw).Trim()
    if (-not $sessionId) {
        Write-Host "CCRouter: ? | $ts"
        exit 0
    }

    $configPath = Join-Path ($env:USERPROFILE ?? $env:HOME ?? "/tmp") ".ccrouter/config.json"
    $daemonUrl = "http://127.0.0.1:19919"
    if (Test-Path $configPath) {
        $config = Get-Content $configPath -Raw | ConvertFrom-Json
        if ($config.daemonUrl) { $daemonUrl = $config.daemonUrl }
    }

    $session = Invoke-RestMethod -Uri "$daemonUrl/session/$sessionId" `
        -TimeoutSec 2 -ErrorAction Stop

    Write-Host "$($session.friendly_name) | $ts"
} catch {
    Write-Host "CCRouter: ? | $(Get-Date -Format 'HH:mm:ss')"
    exit 0
}
