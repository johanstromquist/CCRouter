# CCRouter ack-message hook (Windows/PowerShell)
# Acknowledges pushed channel messages so the daemon stops retrying.
try {
    $inputData = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $prompt = $inputData.prompt

    # Match CCRouter channel message pattern: [#channel] sender: message
    if ($prompt -match '^\[(#[a-zA-Z0-9_-]+)\]\s+([a-zA-Z0-9_-]+):') {
        $channel = $Matches[1]
        $sender = $Matches[2]

        # Read session_id from file (no tty on Windows)
        $sidFile = Join-Path ($env:USERPROFILE ?? $env:HOME ?? "/tmp") ".ccrouter/session_id"
        $sessionId = ""
        if (Test-Path $sidFile) {
            $sessionId = (Get-Content $sidFile -Raw).Trim()
        }

        if ($sessionId) {
            $configPath = Join-Path ($env:USERPROFILE ?? $env:HOME ?? "/tmp") ".ccrouter/config.json"
            $daemonUrl = "http://127.0.0.1:19919"
            if (Test-Path $configPath) {
                $config = Get-Content $configPath -Raw | ConvertFrom-Json
                if ($config.daemonUrl) { $daemonUrl = $config.daemonUrl }
            }

            $payload = @{
                channel = $channel
                sender = $sender
                session_id = $sessionId
            } | ConvertTo-Json

            Invoke-RestMethod -Uri "$daemonUrl/ack" `
                -Method Post -Body $payload -ContentType "application/json" `
                -TimeoutSec 2 -ErrorAction SilentlyContinue | Out-Null
        }
    }
} catch {
    exit 0
}
