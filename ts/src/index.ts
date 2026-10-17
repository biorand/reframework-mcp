#!/usr/bin/env node
/**
 * REFramework MCP Server
 *
 * Tools:
 *   execute_code   – run Lua inside a running RE Engine game via REFramework
 *   install_bridge – install the bundled mcp.lua into a game's reframework\autorun
 *   set_data_dir   – configure (and remember) the reframework\data directory
 *
 * Workflow (execute_code):
 *   1. Write Lua code to <dataDir>/mcp_input.lua
 *   2. Poll until the file is empty (the in-game bridge blanks it after running)
 *   3. Read <dataDir>/mcp_output.txt and return its contents
 *
 * Configuration (env vars):
 *   REF_DATA_DIR   – absolute path to the reframework/data folder (optional; if
 *                    omitted the agent can set it with install_bridge/set_data_dir
 *                    and the choice is persisted between server starts)
 *   POLL_INTERVAL  – ms between polls while waiting   (default: 500)
 *   POLL_TIMEOUT   – ms before giving up              (default: 30000)
 *   REF_MCP_CONFIG – override the persisted config file location
 *   REF_MCP_LUA    – override the bundled mcp.lua source path
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── config ────────────────────────────────────────────────────────────────────

const POLL_INTERVAL = Number(process.env.POLL_INTERVAL ?? 500);
const POLL_TIMEOUT  = Number(process.env.POLL_TIMEOUT  ?? 30_000);

/**
 * Marker written into mcp_input.lua and echoed into mcp_output.txt so output
 * can be matched to the request that produced it.
 */
const REQUEST_ID_PATTERN = /refmcp_request_id:\s*([A-Za-z0-9-]+)/;

/** File where the runtime data-dir choice is persisted between server starts. */
const CONFIG_PATH =
  process.env.REF_MCP_CONFIG ??
  (process.platform === "win32"
    ? path.join(
        process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"),
        "reframework-mcp",
        "config.json"
      )
    : path.join(
        process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"),
        "reframework-mcp",
        "config.json"
      ));

interface PersistedConfig {
  dataDir?: string;
}

function loadConfig(): PersistedConfig {
  try {
    const parsed: unknown = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    if (parsed && typeof parsed === "object") {
      const { dataDir } = parsed as Record<string, unknown>;
      if (typeof dataDir === "string" && dataDir) return { dataDir };
    }
    return {};
  } catch {
    return {};
  }
}

const envDataDir = process.env.REF_DATA_DIR ? path.resolve(process.env.REF_DATA_DIR) : null;
const savedDataDir = loadConfig().dataDir;

/** Active data directory; null until configured via env, config file or a tool. */
let dataDir: string | null = envDataDir ?? (savedDataDir ? path.resolve(savedDataDir) : null);

async function persistDataDir(dir: string): Promise<boolean> {
  try {
    const config = loadConfig();
    config.dataDir = dir;
    await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
    await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf8");
    return true;
  } catch (err) {
    process.stderr.write(
      `[reframework-mcp] warning: could not save config to ${CONFIG_PATH}: ${String(err)}\n`
    );
    return false;
  }
}

function requireDataDir(): string {
  if (!dataDir) {
    throw new Error(
      "No reframework data directory is configured.\n" +
      "  • If REFramework is already installed, call set_data_dir with the game install " +
      "directory (e.g. C:\\Games\\RE9) or with <game>\\reframework\\data.\n" +
      "  • Otherwise call install_bridge with the game install directory to install the " +
      "Lua bridge and configure this automatically.\n" +
      "Alternatively set REF_DATA_DIR when registering this MCP server."
    );
  }
  return dataDir;
}

// ── helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Read a file, returning "" if it doesn't exist yet.
 */
async function readSafe(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function isDir(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * True when a directory looks like a reframework folder: named "reframework",
 * or containing an autorun/plugins folder.
 */
async function isReframeworkDir(dir: string): Promise<boolean> {
  if (path.basename(dir).toLowerCase() === "reframework" && (await isDir(dir))) return true;
  return (await isDir(path.join(dir, "autorun"))) || (await isDir(path.join(dir, "plugins")));
}

/**
 * Turn a user-supplied path (game install dir, reframework dir, data dir or any
 * path inside the game tree) into the reframework\data directory.
 * Creates the data folder when REFramework exists but the game hasn't started once.
 */
async function resolveDataDir(input: string): Promise<string> {
  let base = path.resolve(input);
  if (await isFile(base)) base = path.dirname(base);

  const baseName = path.basename(base).toLowerCase();

  // The data directory itself was passed; create it when the parent is a
  // reframework folder and the game has not created it yet.
  if (baseName === "data" && (await isReframeworkDir(path.dirname(base)))) {
    if (!(await isDir(base))) await fs.mkdir(base, { recursive: true });
    return base;
  }

  if (!(await isDir(base))) {
    throw new Error(
      `"${base}" does not exist. Pass the game install directory (e.g. C:\\Games\\RE9), ` +
      `the reframework directory, or the reframework\\data directory.`
    );
  }

  // A data directory with an unusual name (it already holds MCP files).
  if (
    (await isFile(path.join(base, "mcp_input.lua"))) ||
    (await isFile(path.join(base, "mcp_output.txt")))
  ) {
    return base;
  }

  // The game install directory was passed: <base>\reframework\data
  if (await isDir(path.join(base, "reframework"))) {
    const dataPath = path.join(base, "reframework", "data");
    await fs.mkdir(dataPath, { recursive: true });
    return dataPath;
  }

  // Any other path inside the game tree (e.g. the autorun folder): walk up to
  // the game install directory.
  const gameRoot = await findGameRoot(base);
  if (gameRoot) {
    const dataPath = path.join(gameRoot, "reframework", "data");
    await fs.mkdir(dataPath, { recursive: true });
    return dataPath;
  }

  throw new Error(
    `Could not find a reframework\\data directory from "${base}".\n` +
    `Pass one of:\n` +
    `  - the game install directory (the folder containing the game .exe)\n` +
    `  - the reframework directory\n` +
    `  - the data directory itself\n` +
    `  - any path inside the game install directory\n` +
    `If REFramework is not installed yet, call install_bridge instead.`
  );
}

/**
 * Health check for a resolved data directory. Returns a short human-readable
 * note (or warning) about what was found around it.
 */
async function describeDataDir(dir: string): Promise<string> {
  const refDir = path.dirname(dir);
  const autorunDir = path.join(refDir, "autorun");
  const hasReframework = (await isDir(autorunDir)) || (await isDir(path.join(refDir, "plugins")));

  if (!hasReframework) {
    return (
      `Warning: this does not look like a reframework\\data directory ` +
      `(no autorun or plugins folder found in "${refDir}"). ` +
      `Make sure REFramework is installed and the path is correct.`
    );
  }

  const bridge = path.join(autorunDir, "mcp.lua");
  return (await isFile(bridge))
    ? `Lua bridge found at ${bridge}.`
    : `Lua bridge (mcp.lua) not found in ${autorunDir} - call install_bridge to install it.`;
}

/**
 * Walk up from a path until a directory containing a "reframework" folder is
 * found (the game install directory). Returns null when there is none.
 */
async function findGameRoot(start: string): Promise<string | null> {
  let dir = path.resolve(start);
  if (await isFile(dir)) dir = path.dirname(dir);

  while (true) {
    if (await isDir(path.join(dir, "reframework"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const KNOWN_GAME_EXES = ["re9.exe", "re8.exe", "re7.exe", "re4.exe", "re3.exe", "re2.exe"];

/** Best-effort detection of the game executable, for friendlier messages. */
async function findGameExe(gameRoot: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await fs.readdir(gameRoot);
  } catch {
    return null;
  }

  const byLower = new Map(entries.map((entry) => [entry.toLowerCase(), entry]));
  for (const known of KNOWN_GAME_EXES) {
    const found = byLower.get(known);
    if (found) return found;
  }
  for (const [lower, original] of byLower) {
    if (/^re[0-9].*\.exe$/.test(lower)) return original;
  }
  return null;
}

/** Candidate locations of the bundled Lua bridge source. */
function luaSourceCandidates(): string[] {
  const candidates = [
    process.env.REF_MCP_LUA,
    path.join(__dirname, "..", "..", "lua", "mcp.lua"), // repo layout: ts/dist -> lua/mcp.lua (live edits win)
    path.join(__dirname, "mcp.lua"),                    // copied next to dist/index.js by the build (packaged)
    path.join(__dirname, "..", "lua", "mcp.lua"),
  ];
  return candidates.filter((candidate): candidate is string => Boolean(candidate));
}

async function findLuaSource(): Promise<string | null> {
  for (const candidate of luaSourceCandidates()) {
    if (await isFile(candidate)) return candidate;
  }
  return null;
}

/** Checklist-style error for a timed-out execute_code call. */
async function buildTimeoutError(inputPath: string): Promise<Error> {
  const refDir = path.dirname(path.dirname(inputPath));
  const bridgePath = path.join(refDir, "autorun", "mcp.lua");
  const bridgeHint = (await isFile(bridgePath))
    ? `Lua bridge found at ${bridgePath}.`
    : `Lua bridge NOT found at ${bridgePath} - call install_bridge to install it.`;

  return new Error(
    `Timed out after ${POLL_TIMEOUT} ms waiting for the Lua bridge to consume the input file.\n` +
    `Checklist:\n` +
    `  1. The game is running with REFramework loaded.\n` +
    `  2. ${bridgeHint}\n` +
    `  3. If the bridge was just installed or updated, reload the Lua scripts in-game ` +
    `(REFramework menu > ScriptRunner > Reset Scripts) or restart the game.\n` +
    `  4. Look for "[mcp]" messages in the REFramework log (in the game directory).`
  );
}

// ── tool implementations ──────────────────────────────────────────────────────

// Tool calls share state (the input/output files, the active data dir and the
// config file), so run them one at a time.
let queue: Promise<void> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const result = queue.then(task);
  queue = result.then(() => undefined, () => undefined);
  return result;
}

async function executeCode(code: string): Promise<string> {
  const dir = requireDataDir();
  const inputPath = path.join(dir, "mcp_input.lua");
  const outputPath = path.join(dir, "mcp_output.txt");
  const requestId = randomUUID();
  const stampedCode = `-- refmcp_request_id: ${requestId}\n${code}`;
  const deadline = Date.now() + POLL_TIMEOUT;

  for (;;) {
    // 1. Write the Lua code to the input file.
    try {
      await fs.writeFile(inputPath, stampedCode, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(
          `Data directory "${dir}" does not exist. ` +
          `Call set_data_dir again with a valid path (or install_bridge).`
        );
      }
      throw err;
    }

    // 2. Wait for the bridge to blank the file (signals execution done).
    let consumed = false;
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL);
      const content = await readSafe(inputPath);
      if (content.trim() === "") {
        consumed = true;
        break;
      }
    }
    if (!consumed) {
      // Clear the stale input so a bridge starting later does not execute it.
      await fs.writeFile(inputPath, "", "utf8").catch(() => undefined);
      throw await buildTimeoutError(inputPath);
    }

    // 3. Read the output and make sure it belongs to this request. If the
    // bridge consumed a stale script it wipes our input before it runs, so on
    // a request-id mismatch write our code again and keep waiting. Output
    // without a request id comes from an older bridge and is accepted as-is.
    const output = await readSafe(outputPath);
    const outputId = output.match(REQUEST_ID_PATTERN)?.[1];
    if (outputId === undefined || outputId === requestId) {
      return output.trim() === ""
        ? "(no output written – check the REFramework logs)"
        : output;
    }
    process.stderr.write(
      `[reframework-mcp] warning: bridge consumed a stale script (output request ${outputId}); retrying\n`
    );
  }
}

async function installBridge(input?: string): Promise<string> {
  let searchedFrom: string;

  if (input) {
    const abs = path.resolve(input);
    if (!(await isDir(abs)) && !(await isFile(abs))) {
      throw new Error(
        `"${abs}" does not exist. Pass the game install directory (the folder containing ` +
        `the game .exe), the reframework folder, or a path inside them.`
      );
    }
    searchedFrom = abs;
  } else if (dataDir) {
    searchedFrom = dataDir;
  } else {
    throw new Error(
      "Where is the game installed? Pass the game install directory, e.g. " +
      `install_bridge with path "C:\\Games\\RE9".`
    );
  }

  const gameRoot = await findGameRoot(searchedFrom);
  if (!gameRoot) {
    const startMissing = !(await isDir(searchedFrom)) && !(await isFile(searchedFrom));
    throw new Error(
      (startMissing
        ? `"${searchedFrom}" does not exist, and no "reframework" folder was found at or ` +
          `above it.\n`
        : `REFramework does not appear to be installed at or above "${searchedFrom}".\n`) +
      `I looked for a "reframework" folder in the game install directory (next to the ` +
      `game .exe) and its parents.\n` +
      `Install REFramework first: download a release, then extract dinput8.dll and the ` +
      `reframework folder into the game install directory.\n` +
      `  https://github.com/praydog/REFramework-nightly/releases`
    );
  }

  const refDir = path.join(gameRoot, "reframework");
  const autorunDir = path.join(refDir, "autorun");
  const targetPath = path.join(autorunDir, "mcp.lua");

  const source = await findLuaSource();
  if (!source) {
    throw new Error(
      "Could not find the bundled mcp.lua bridge source.\nLooked in:\n" +
      luaSourceCandidates().map((candidate) => `  ${candidate}`).join("\n") +
      "\nRebuild the server (npm run build) or set REF_MCP_LUA to its path."
    );
  }

  // Install (or refresh) the bridge script.
  await fs.mkdir(autorunDir, { recursive: true });
  const sourceCode = await fs.readFile(source, "utf8");
  const previous = await readSafe(targetPath);

  let action: string;
  if (previous === sourceCode) {
    action = "already up to date";
  } else {
    await fs.writeFile(targetPath, sourceCode, "utf8");
    action = previous ? "updated" : "copied";
  }

  // Make sure the data directory exists and activate it.
  const gameDataDir = path.join(refDir, "data");
  await fs.mkdir(gameDataDir, { recursive: true });
  dataDir = gameDataDir;
  const persisted = await persistDataDir(gameDataDir);

  const exe = await findGameExe(gameRoot);
  const lines = [
    `Lua bridge ${action}.`,
    `  game install : ${gameRoot}`,
  ];
  if (exe) lines.push(`  game exe     : ${exe}`);
  lines.push(
    `  bridge file  : ${targetPath}`,
    `  source       : ${source}`,
    `  data dir     : ${gameDataDir} (active)`
  );

  if (envDataDir && !samePath(envDataDir, gameDataDir)) {
    lines.push(`  note         : REF_DATA_DIR=${envDataDir} takes over again after a restart`);
  } else if (persisted) {
    lines.push(`  note         : saved to ${CONFIG_PATH}; future server starts use it automatically`);
  } else {
    lines.push(
      `Warning: could not save the active data dir to ${CONFIG_PATH}; it will not survive a restart.`
    );
  }

  if (!(await isFile(path.join(gameRoot, "dinput8.dll")))) {
    lines.push(
      `Warning: no dinput8.dll found next to the game .exe. If REFramework is not set up ` +
      `correctly the bridge will never load.`
    );
  }

  if (action === "already up to date") {
    lines.push("The bridge is already current. Use execute_code once the game is running.");
  } else {
    lines.push(
      "ACTION REQUIRED: Tell the user the Lua bridge was just installed/updated and they must " +
      "reload the Lua plugins in-game before execute_code will work (open the REFramework menu " +
      "and use ScriptRunner -> Reset Scripts, or simply restart the game). " +
      "The bridge is only loaded on a script reload."
    );
  }
  return lines.join("\n");
}

function samePath(a: string, b: string): boolean {
  const na = path.resolve(a);
  const nb = path.resolve(b);
  return process.platform === "win32" ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

async function setDataDir(input: string): Promise<string> {
  const dir = await resolveDataDir(input);
  dataDir = dir;
  const persisted = await persistDataDir(dir);

  const lines = [`Data directory set to ${dir}.`, await describeDataDir(dir)];
  if (envDataDir) {
    lines.push(
      `Note: REF_DATA_DIR is set to ${envDataDir} and will take over again after a restart ` +
      `(update the env value to make this permanent).`
    );
  } else if (persisted) {
    lines.push(`Saved to ${CONFIG_PATH} - future server starts use it automatically.`);
  } else {
    lines.push(
      `Warning: could not save the choice to ${CONFIG_PATH}; it will not survive a restart.`
    );
  }
  return lines.join("\n");
}

// ── server setup ──────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "reframework",
  version: "1.1.0",
});

server.tool(
  "execute_code",

  "Execute Lua code inside a running RE Engine game via REFramework. " +
  "The code runs in the game process and has full access to REFramework APIs " +
  "(sdk, re, log, fs, json, imgui, draw). " +
  "Use print() to produce output; the final return value is also captured. " +
  "Requires mcp.lua installed in the game's reframework/autorun folder and a configured " +
  "data directory (use install_bridge or set_data_dir if needed).",

  {
    code: z
      .string()
      .min(1)
      .describe("Lua source code to execute inside the game"),
  },

  async ({ code }) => {
    try {
      const output = await enqueue(() => executeCode(code));
      return {
        content: [{ type: "text", text: output }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `[MCP error] ${message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  "set_data_dir",

  "Set the reframework/data directory used by execute_code. Call this when REFramework is " +
  "already installed but the server was started without REF_DATA_DIR. Accepts the game " +
  "install directory (e.g. C:\\Games\\RE9), the reframework directory, or the data " +
  "directory itself. The choice is remembered for future server starts unless REF_DATA_DIR " +
  "is set.",

  {
    path: z
      .string()
      .min(1)
      .describe(
        "Game install directory, reframework directory, or reframework/data directory (absolute path)"
      ),
  },

  async ({ path: input }) => {
    try {
      const output = await enqueue(() => setDataDir(input));
      return {
        content: [{ type: "text", text: output }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `[MCP error] ${message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  "install_bridge",

  "Install the REFramework Lua bridge (mcp.lua) into a game so execute_code can run. " +
  "Copies the bundled mcp.lua to <game>\\reframework\\autorun\\mcp.lua, creates the " +
  "<game>\\reframework\\data directory and makes it the active data directory. " +
  "Accepts the game install directory (e.g. C:\\Games\\RE9), the reframework directory, " +
  "or a path inside them; when omitted, the currently configured data directory is used. " +
  "Fails with instructions if REFramework is not installed at the given location. " +
  "When the bridge is copied or updated, tell the user to reload the Lua scripts in-game " +
  "(or restart the game) so the new bridge actually loads.",

  {
    path: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Game install directory, reframework directory, or a path inside them (absolute path)"
      ),
  },

  async ({ path: input }) => {
    try {
      const output = await enqueue(() => installBridge(input));
      return {
        content: [{ type: "text", text: output }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `[MCP error] ${message}` }],
        isError: true,
      };
    }
  }
);

// ── entry point ───────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // MCP servers communicate over stdio; log to stderr so it doesn't corrupt the stream.
  process.stderr.write(
    `[reframework-mcp] ready\n` +
    `  data dir : ${dataDir ?? "(not set - use the set_data_dir or install_bridge tool)"}\n` +
    `  config   : ${CONFIG_PATH}\n` +
    `  poll     : every ${POLL_INTERVAL} ms, timeout ${POLL_TIMEOUT} ms\n`
  );

  if (dataDir && !(await isDir(dataDir))) {
    process.stderr.write(
      `[reframework-mcp] warning: data dir ${dataDir} does not exist yet\n`
    );
  }
}

main().catch((err) => {
  process.stderr.write(`[reframework-mcp] fatal: ${err}\n`);
  process.exit(1);
});
