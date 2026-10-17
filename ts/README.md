# @biorand/reframework-mcp

MCP server for running Lua inside RE Engine games via
[REFramework](https://github.com/praydog/REFramework).

## Add to your MCP servers

```json
{
  "mcpServers": {
    "reframework": {
      "command": "npx",
      "args": ["-y", "@biorand/reframework-mcp"]
    }
  }
}
```

Pin a version if you want reproducible setups, e.g. `"@biorand/reframework-mcp@1.1.0"`.

## Setup

`REF_DATA_DIR` is optional. On first use, ask your agent to run the `install_bridge`
tool with your game install directory (e.g. `C:\Games\RE9`). It installs the Lua
bridge into `reframework\autorun`, points the server at `reframework\data`, and
remembers the choice. Reload the Lua scripts in-game (REFramework menu →
ScriptRunner → Reset Scripts, or restart the game) after the bridge is installed
or updated.

You can also set the environment variable explicitly when registering the server:

```json
"env": {
  "REF_DATA_DIR": "C:\\Games\\RE9\\reframework\\data"
}
```

## Tools

| Tool | Description |
| --- | --- |
| `execute_code` | Execute Lua inside a running game via REFramework. |
| `install_bridge` | Install/update the Lua bridge in a game and activate its data directory. |
| `set_data_dir` | Point the server at an existing `reframework\data` directory. |

## Requirements

- Node.js 18+
- A supported RE Engine game with REFramework installed

See the [repository README](https://github.com/biorand/reframework-mcp) for the
full documentation, environment variables and troubleshooting.
