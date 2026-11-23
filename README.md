# Kumbatio Energy for Claude

`@kumbatio/energy-mcp` shares the energy level you set for yourself with AI assistants. You pick
one of five levels (Peak, Active, Steady, Low or Rest), it is kept in one file on your computer,
and an assistant that reads it sizes its answers, the number of options it offers and the steps it
takes on its own to that level.

The plugin never measures or guesses your level. The server stores a level only when it is asked
to, and the skills tell Claude to ask for that only when you state one.

This folder is a Claude plugin: a local MCP server, three skills and a terminal command. The
server has no dependencies and is plain, readable JavaScript.

## Where it loads

The server is a program that runs on your computer, so the plugin loads in Claude Code and in
Cowork sessions on your computer. Claude.ai chat, on the web and on mobile, ignores it.

## What's inside

- **The energy server** (`.mcp.json`, `src/server.mjs`): a local MCP server over stdio.
  - `get_energy_guidance` returns your level with the choice budget, autonomy limits and
    plain-language guidance for it.
  - `check_autonomy_action` says whether a planned unattended action fits the limits of your
    level, and names each limit it exceeds.
  - `set_energy_level` stores a new level. It is the only tool that writes.
  - Four resources hold the same readings: `energy://state`, `energy://autonomy`,
    `energy://choice-budget` and `energy://guidance`.
- **Skills**
  - `energy-aware-responses` - read the level before planning or listing options, and size the
    answer to it.
  - `energy-autonomy-check` - check before chaining steps you will not see one by one, or before
    sending wording written for you.
  - `energy-check-in` - record a level only when you state one; never infer it.
- **The terminal dial** (`src/cli.mjs`): see or set the level from a terminal.

## Use it

Install the plugin, then tell Claude your level once. It stays set until you change it.

- "I'm at Low today."
- "Set my energy to 75."
- "What's my energy level?"
- "What should I do next on this branch?" (at Low you get one next step, at Peak the full picture)
- "Tidy up these twelve files while I'm away." (Claude checks how many steps it may chain first)
- "I'm done for today, I'm in Rest."

Until a level is set, the server reports the default (level 100, marked as never set) and the
skills tell Claude to work as usual.

## What changes for an AI assistant

| Energy | Choice budget | Autonomy limits |
| --- | --- | --- |
| `100` Peak | Full options, detailed depth | Up to 8 steps, 60% confidence, drafts allowed |
| `75` Active | Up to 5 options, balanced | Up to 5 steps, 70% confidence, drafts allowed |
| `50` Steady | Up to 3 options, concise | Up to 3 steps, 80% confidence, no unsolicited suggestions |
| `25` Low | One clear next step | 1 step at a time, 90% confidence, fixed templates only |
| `0` Rest | Quiet reading, no asks | 1 certain templated step only |

These are readings and advice. The server blocks nothing: `check_autonomy_action` returns an
answer, and acting on it is up to the assistant.

## Data

- **What runs:** Claude starts `node` on `src/server.mjs` inside the plugin folder. That is the
  whole command; there is no install step and no package to download.
- **What it reads and writes:** one JSON file, found in this order:
  1. the path in `KUMBATIO_ENERGY_FILE`, if set
  2. `$XDG_STATE_HOME/kumbatio/energy-state.json`, if `XDG_STATE_HOME` is set
  3. `%LOCALAPPDATA%\kumbatio\energy-state.json` on Windows
  4. `~/.config/kumbatio/energy-state.json` otherwise
- **What is in the file:** five fields.

  ```json
  {
    "level": 25,
    "timestamp": 1795478400000,
    "source": "manual",
    "revision": 0,
    "origin": "kumbatio-energy-mcp"
  }
  ```

- **When it writes:** only when `set_energy_level` is called, or when you use the terminal dial.
  The new state goes to a temporary file in the same folder and is renamed into place; the folder
  is created if it is missing. Reading creates nothing.
- **Network:** none. The server opens no connection and has no telemetry or account. Its source
  imports only Node's `crypto`, `fs`, `os`, `path`, `readline` and `url` modules.
- **Your conversation:** what a tool returns (your level and the guidance for it) becomes part of
  your conversation with Claude, which Anthropic handles under its own terms.

Other apps on your computer that follow the same convention read and write the same file, so a
level set in one place is seen by all of them. To stop sharing the level, uninstall the plugin. To
erase it, delete the file: a server that is already running keeps the last level it read until it
exits, and a new one starts from the default.

## Requirements

Node.js 22 or later, with `node` on your `PATH`. Check with `node --version`.

## Install in Claude Code

```
/plugin install kumbatio-energy --marketplace kumbatio/energy-mcp
```

## Other MCP hosts

The server speaks MCP over stdio (JSON-RPC, one message per line) and answers protocol versions
2025-11-25, 2025-06-18, 2025-03-26 and 2024-11-05. In Cursor, Antigravity or another host that
takes a command, point it at the server file:

```json
{
  "mcpServers": {
    "kumbatio-energy": {
      "command": "node",
      "args": ["/path/to/energy-mcp/src/server.mjs"]
    }
  }
}
```

The skills are Claude plugin files; other hosts get the tools and resources only.

## Terminal dial

```bash
node src/cli.mjs         # see current level & active adaptations
node src/cli.mjs 25      # set Low energy across all watching apps
node src/cli.mjs cycle   # step down one level (100 -> 75 -> 50 -> 25 -> 0 -> 100)
```

## Development

```bash
npm test
```

The tests need nothing installed. They start the server over stdio and always use a temporary
state file, so your own file is not touched.

`src/energy-levels.mjs` holds the levels, the limits per level and the state-file rules, ported
from [`@kumbatio/energy-system`](https://github.com/kumbatio/energy-system) 3.0.0 so that the
server loads nothing from outside this folder. When those rules change there, they change here.

## License

MIT. See [LICENSE](LICENSE).
