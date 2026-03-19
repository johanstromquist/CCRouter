# claude-r.ps1: Resume the last Claude Code session for the current workspace.
# Reads session info persisted by the CCRouter Cursor extension.
#
# Supports two persistence formats:
#   New: directory of per-bridge files at last-sessions/{hash}/{port}.json
#   Old: single JSON array file at last-sessions/{hash}.json
#
# Usage:
#   claude-r           # resume the most recent session
#   claude-r --list    # show all saved sessions for this workspace
#   claude-r --pick    # interactive picker for multi-session workspaces

param(
    [switch]$list,
    [switch]$pick
)

$sessionsDir = Join-Path ($env:USERPROFILE ?? $env:HOME ?? "/tmp") ".ccrouter/last-sessions"

# Hash the cwd to find the session file/directory
$md5 = [System.Security.Cryptography.MD5]::Create()
$bytes = [System.Text.Encoding]::UTF8.GetBytes((Get-Location).Path)
$hash = ($md5.ComputeHash($bytes) | ForEach-Object { $_.ToString("x2") }) -join ""
$sessionPath = Join-Path $sessionsDir $hash
$sessionFile = Join-Path $sessionsDir "$hash.json"

# Load sessions from either new (directory) or old (file) format
function Load-Sessions {
    if (Test-Path $sessionPath -PathType Container) {
        # New format: merge all per-bridge files in the directory
        $entries = @()
        $seen = @{}
        foreach ($file in Get-ChildItem -Path $sessionPath -Filter "*.json" -ErrorAction SilentlyContinue) {
            try {
                $data = Get-Content $file.FullName -Raw | ConvertFrom-Json
                if ($data -is [array]) {
                    foreach ($entry in $data) {
                        $sid = $entry.sessionId
                        if ($sid -and -not $seen.ContainsKey($sid)) {
                            $entries += $entry
                            $seen[$sid] = $true
                        }
                    }
                } else {
                    $sid = $data.sessionId
                    if ($sid -and -not $seen.ContainsKey($sid)) {
                        $entries += $data
                        $seen[$sid] = $true
                    }
                }
            } catch {
                # Expected: file may be corrupt or partially written
            }
        }
        # Sort by updatedAt descending
        $entries = $entries | Sort-Object -Property updatedAt -Descending
        return $entries
    } elseif (Test-Path $sessionFile) {
        # Old format: read directly as JSON array
        return Get-Content $sessionFile -Raw | ConvertFrom-Json
    } else {
        return @()
    }
}

$sessions = Load-Sessions

if ($sessions.Count -eq 0) {
    Write-Host "No saved sessions for this workspace ($(Get-Location))"
    Write-Host "Start a session normally with 'claude' first."
    exit 1
}

if ($list) {
    Write-Host "Saved sessions for $(Get-Location):"
    Write-Host ""
    for ($i = 0; $i -lt $sessions.Count; $i++) {
        $s = $sessions[$i]
        $sid = $s.sessionId.Substring(0, 12)
        Write-Host "  [$($i+1)] $($s.friendlyName) (session: $sid..., last seen: $($s.updatedAt))"
    }
    exit 0
}

if ($pick) {
    Write-Host "Saved sessions for $(Get-Location):"
    Write-Host ""
    for ($i = 0; $i -lt $sessions.Count; $i++) {
        $s = $sessions[$i]
        $sid = $s.sessionId.Substring(0, 12)
        Write-Host "  [$($i+1)] $($s.friendlyName) ($sid...)"
    }
    Write-Host ""
    $choice = Read-Host "Pick a session number"
    $idx = [int]$choice - 1
    if ($idx -lt 0 -or $idx -ge $sessions.Count) {
        Write-Host "Invalid selection."
        exit 1
    }
    $sessionId = $sessions[$idx].sessionId
    Write-Host "Resuming session $sessionId..."
    & claude --resume $sessionId
    exit 0
}

# Default: resume the most recent session
$latest = $sessions[0]
if ($sessions.Count -gt 1) {
    Write-Host "Multiple sessions found. Resuming most recent: $($latest.friendlyName)"
    Write-Host "(Use 'claude-r -pick' to choose a different one)"
    Write-Host ""
}

Write-Host "Resuming session: $($latest.friendlyName) ($($latest.sessionId))"
& claude --resume $latest.sessionId
