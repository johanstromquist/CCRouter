# CCRouter auto-ack hook -- acknowledges received CCRouter messages.
# Runs on UserPromptSubmit. Detects [#channel] sender: ... pattern
# and sends an ack to the daemon so the sender knows delivery succeeded.
# Reads session_id from stdin JSON (platform-agnostic).
try {
    $inputData = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $prompt = $inputData.prompt
    $sessionId = $inputData.session_id

    if ($prompt -match '^\[(#[a-zA-Z0-9_-]+)\]\s+([a-zA-Z0-9_-]+):') {
        $channel = $Matches[1]
        $sender = $Matches[2]

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
