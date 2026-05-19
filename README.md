# REFramework MCP server

Node-based MCP server integration for REFramework.

## Quick start

1. From the repository root (e.g., `M:\git\refmcp`) run:

   ```powershell
   npm install
   npm run build
   ```

2. Copy the included Lua script into your game install's reframework autorun folder:

   - Source (in this repo): `lua\mcp.lua`
   - Destination (game): `<GAME INSTALL DIR>\reframework\autorun\mcp.lua`

   Example (PowerShell):
   ```powershell
   Copy-Item "M:\git\refmcp\lua\mcp.lua" "C:\Games\RE4\reframework\autorun\mcp.lua"
   ```

## Add to your MCP servers JSON

Add (or merge) the following entry into your MCP servers configuration. Use absolute Windows paths for `args` and env values:

```json
{
  "mcpServers": {
    "reframework": {
      "command": "node",
      "args": ["M:\\git\\refmcp\\dist\\index.js"],
      "env": {
        "REF_DATA_DIR": "C:\\Games\\RE4\\reframework\\data"
      }
    }
  }
}
```

Replace the paths above with the correct locations for your system. The `args` path should point to the built `dist\index.js` (run `npm run build` first).

## Environment variables

The following environment variables may be set for the reframework MCP server (can be set inside the `env` object shown above):

- `REF_DATA_DIR` — Required. Absolute path to the game's `reframework\data` directory. Example: `C:\Games\RE4\reframework\data`
- `POLL_INTERVAL` — Optional. Milliseconds between checks. Default: `500`
- `POLL_TIMEOUT` — Optional. Milliseconds to wait before giving up. Default: `30000`

Example with optional variables:

```json
"env": {
  "REF_DATA_DIR": "C:\\Games\\RE4\\reframework\\data",
  "POLL_INTERVAL": "500",
  "POLL_TIMEOUT": "30000"
}
```

## Notes & troubleshooting

- Ensure `node` is available in PATH and that `M:\git\refmcp\dist\index.js` exists after building.
- Use absolute Windows-style paths (backslashes) in your MCP servers configuration on Windows hosts.
- If the server fails to start, verify `REF_DATA_DIR` points to the correct `reframework\data` directory and that permissions allow reading.

## Where to find files in this repo

- Lua helper: `lua\mcp.lua`
- Source/TypeScript: `ts\` (build outputs to `dist\`)
