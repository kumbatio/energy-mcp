# @kumbatio/energy-mcp

Share your self-declared cognitive energy state with AI assistants (Claude, Cursor, Antigravity, Nami) and every local app watching your machine's energy file.

Zero telemetry. Zero cloud accounts. Self-report only — AI agents can read your energy and respect your limits, and may only update it when you explicitly ask.

## What changes for an AI assistant

| Energy | Choice budget | Autonomy guardrails |
| --- | --- | --- |
| `100` Peak | Full options, detailed depth | Up to 8 steps, 60% confidence, drafts allowed |
| `75` Active | Up to 5 options, balanced | Up to 5 steps, 70% confidence, drafts allowed |
| `50` Steady | Up to 3 options, concise | Up to 3 steps, 80% confidence, no unsolicited prompts |
| `25` Low | **One clear next step** | 1 step at a time, 90% confidence, fixed templates only |
| `0` Rest | Quiet reading, no asks | 1 certain templated step only |

## Quick setup (MCP client config)

```json
{
  "mcpServers": {
    "kumbatio-energy": {
      "command": "node",
      "args": ["/path/to/kumbatio/energy-mcp/src/server.mjs"]
    }
  }
}
```

## Terminal dial

```bash
node src/cli.mjs         # see current level & active adaptations
node src/cli.mjs 25      # set Low energy across all watching apps
node src/cli.mjs cycle   # step down one level (100 -> 75 -> 50 -> 25 -> 0 -> 100)
```
