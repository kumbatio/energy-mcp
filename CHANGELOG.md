# Changelog

All notable changes to `@kumbatio/energy-mcp` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/).

## [0.2.0] - 2026-11-24

### Added

- The folder is a Claude plugin named `kumbatio-energy`: `.claude-plugin/plugin.json`,
  `.claude-plugin/marketplace.json`, an icon, and `.mcp.json`, which starts the bundled server
  with `node`. It loads in Claude Code and in Cowork sessions on your computer.
- Three skills: `energy-aware-responses`, `energy-autonomy-check` and `energy-check-in`. They
  carry the directions that used to sit in the tool descriptions, and say what the unset default
  (level 100, timestamp 0, origin `0-initial`) means.
- Every tool has a title and annotations (`get_energy_guidance` and `check_autonomy_action` are
  read-only; `set_energy_level` writes, is not destructive and is idempotent). Every resource has
  a title.
- `initialize` answers with the client's protocol version when it is 2025-11-25, 2025-06-18,
  2025-03-26 or 2024-11-05, and with 2025-11-25 otherwise. It always answered 2024-11-05 before.
- A LICENSE file (MIT, as in `package.json`).

### Changed

- The server and the terminal dial no longer load `@kumbatio/energy-system` from a neighbouring
  folder. The levels, the limits per level and the state-file rules they use are in
  `src/energy-levels.mjs`, ported from energy-system 3.0.0. There is no dependency and nothing to
  install.
- The server no longer watches the state file's folder. It reads the file before every request,
  as it did, so a level set elsewhere is still seen. Starting the server no longer creates the
  folder; the first write does.
- Tool descriptions say what a tool does and returns. They no longer tell the model when to call
  it.
- `check_autonomy_action` validates its arguments and refuses bad input with an error that names
  the field. It used to coerce them: a misspelled `plannedSteps` was read as one step.
- `set_energy_level` accepts the level only as one of the numbers 0, 25, 50, 75 and 100. A string
  such as `"25"` is now refused.

### Fixed

- `set_energy_level` set Rest when `level` was `null`, `false` or an empty string.
- `set_energy_level` never answered when the state file could not be written. It now returns an
  error with the path and the reason, and the level stays as it was.
- The server did not start, and answered nothing, when its folder had a space in its path or was
  reached through a symbolic link.

## [0.1.0]

The local MCP server (`get_energy_guidance`, `check_autonomy_action`, `set_energy_level`, four
`energy://` resources) and the terminal dial, as they stood before version control.
