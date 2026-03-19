# CCRouter status line -- shows session name in Claude Code footer
# Reads session_id from stdin JSON (provided by CC to all hooks and statusline)
# then queries the daemon HTTP API for the friendly name.
# Platform-agnostic: no env vars, no shared files.
try {
    $sessionJson = [Console]::In.ReadToEnd()
    $session = $sessionJson | ConvertFrom-Json
    $sessionId = $session.session_id
    $ts = Get-Date -Format "HH:mm:ss"

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

    $result = Invoke-RestMethod -Uri "$daemonUrl/session/$sessionId" -TimeoutSec 2 -ErrorAction Stop
    Write-Host "$($result.friendly_name) | $ts"
} catch {
    Write-Host "CCRouter: ? | $(Get-Date -Format 'HH:mm:ss')"
    exit 0
}
