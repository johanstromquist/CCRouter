# PreToolUse hook for CCRouter MCP tools.
# Injects the CC session_id into every CCRouter tool call so the MCP
# server knows which session it serves. Auto-binds on first use.
try {
    $input = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $sid = $input.session_id
    if ($sid) {
        $toolInput = $input.tool_input
        $toolInput | Add-Member -NotePropertyName '_session_id' -NotePropertyValue $sid -Force
        $output = @{
            hookSpecificOutput = @{
                hookEventName = 'PreToolUse'
                permissionDecision = 'allow'
                updatedInput = $toolInput
            }
        }
        $output | ConvertTo-Json -Depth 10
    }
    exit 0
} catch {
    exit 0
}
