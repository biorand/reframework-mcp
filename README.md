# REFramework MCP server

Node-based MCP server integration for REFramework.

## Quick start

1. Install and build the server:

   ```powershell
   cd ts
   npm install
   npm run build
   ```

2. Add the server to your MCP configuration (see [Add to your MCP servers JSON](#add-to-your-mcp-servers-json)).

3. Get the game ready. Easiest: ask your agent to run the `install_bridge` tool with your
   game install directory (e.g. `C:\Games\RE9`). It will copy `mcp.lua` into
   `<GAME INSTALL DIR>\reframework\autorun\mcp.lua`, create/enable the data directory, and
   verify REFramework is actually installed (it reports exactly what is wrong if it is not).

   If REFramework is already installed and the bridge is already in place, the agent can just
   call `set_data_dir` instead. Both tools remember the choice, so `REF_DATA_DIR` is optional.

   After the bridge is installed or updated, reload the Lua scripts in-game
   (REFramework menu → ScriptRunner → Reset Scripts, or restart the game) before calling
   `execute_code` — autorun scripts are only loaded on startup/reload.

Manual alternative to `install_bridge`:

- Source (in this repo): `lua\mcp.lua`
- Destination (game): `<GAME INSTALL DIR>\reframework\autorun\mcp.lua`

Example (PowerShell):

```powershell
Copy-Item "M:\git\refmcp\lua\mcp.lua" "C:\Games\RE9\reframework\autorun\mcp.lua"
```

## Add to your MCP servers JSON

Add (or merge) the following entry into your MCP servers configuration. Use absolute Windows
paths for `args` and env values:

```json
{
  "mcpServers": {
    "reframework": {
      "command": "node",
      "args": ["M:\\git\\refmcp\\ts\\dist\\index.js"],
      "env": {
        "REF_DATA_DIR": "C:\\Games\\RE4\\reframework\\data"
      }
    }
  }
}
```

`REF_DATA_DIR` can be omitted entirely — the agent can configure everything at runtime with
`install_bridge` / `set_data_dir` (see below).

## Tools

| Tool | Description |
| --- | --- |
| `execute_code` | Execute Lua code inside a running RE Engine game via REFramework. Requires the bridge installed and a configured data directory. |
| `install_bridge` | Copy the bundled `mcp.lua` to `<game>\reframework\autorun\mcp.lua`, create/activate the `<game>\reframework\data` directory, and verify REFramework is installed. Accepts the game install dir, the `reframework` dir, or a path inside them. |
| `set_data_dir` | Point the server at a game's `reframework\data` folder. Accepts the game install dir, the `reframework` dir, or the data dir itself. Useful when REFramework and `mcp.lua` are already installed. |

`install_bridge` fails with instructions when it cannot find a `reframework` folder (i.e.
REFramework is not installed) or when the path does not exist, and warns when no
`dinput8.dll` is found next to the game executable. When it copies or updates `mcp.lua`, its
output explicitly tells the agent to ask the user to reload the Lua plugins in-game, because
REFramework only loads autorun scripts on startup or script reload.

If neither `REF_DATA_DIR` nor a saved config exists, `execute_code` fails fast with the same
guidance instead of timing out.

## Environment variables

The following environment variables may be set for the reframework MCP server (can be set
inside the `env` object shown above):

- `REF_DATA_DIR` — Optional. Absolute path to the game's `reframework\data` directory.
  Example: `C:\Games\RE4\reframework\data`. When set, it always wins over a value saved by
  `install_bridge`/`set_data_dir`.
- `POLL_INTERVAL` — Optional. Milliseconds between checks. Default: `500`
- `POLL_TIMEOUT` — Optional. Milliseconds to wait before giving up. Default: `30000`
- `REF_MCP_CONFIG` — Optional. Override where the runtime data-dir choice is saved.
  Default: `%APPDATA%\reframework-mcp\config.json` (Windows) or
  `$XDG_CONFIG_HOME/reframework-mcp/config.json` (elsewhere).
- `REF_MCP_LUA` — Optional. Override the path of the bundled `mcp.lua` source used by
  `install_bridge`.

Example with optional variables:

```json
"env": {
  "REF_DATA_DIR": "C:\\Games\\RE4\\reframework\\data",
  "POLL_INTERVAL": "500",
  "POLL_TIMEOUT": "30000"
}
```

## Notes & troubleshooting

- Ensure `node` is available in PATH and that `ts\dist\index.js` exists after building.
- Use absolute Windows-style paths (backslashes) in your MCP servers configuration on Windows hosts.
- If `execute_code` times out, check (the error message lists these too):
  - the game is running with REFramework loaded;
  - `mcp.lua` exists at `<game>\reframework\autorun\mcp.lua` (run `install_bridge` if not);
  - the Lua scripts were reloaded after the bridge was installed/updated;
  - the configured data directory matches the game you are running;
  - the REFramework log (in the game directory) for `[mcp]` messages.

## Where to find files in this repo

- Lua helper: `lua\mcp.lua`
- Source/TypeScript: `ts\` (build outputs to `ts\dist\`, including a copy of `mcp.lua`)
