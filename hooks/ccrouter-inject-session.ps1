# PreToolUse hook for CCRouter MCP tools.
# Injects the CC session_id into every CCRouter tool call so the MCP
# server knows which session it serves. Auto-binds on first use.
try {
    $input = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $sid = $input.session_id
    if ($sid) {
        $input.tool_input | Add-Member -NotePropertyName '_session_id' -NotePropertyValue $sid -Force
    }
    $input | ConvertTo-Json -Depth 10
} catch {
    # On error, pass through unchanged
    [Console]::In.ReadToEnd()
}
