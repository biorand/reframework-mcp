#!/usr/bin/env node
/**
 * REFramework MCP Server
 *
 * Exposes a single tool: execute_code
 *
 * Workflow:
 *   1. Write Lua code to <dataDir>/mcp_input.lua
 *   2. Poll until the file is empty (the in-game plugin blanks it after running)
 *   3. Read <dataDir>/mcp_output.txt and return its contents
 *
 * Configuration (env vars):
 *   REF_DATA_DIR   – absolute path to the reframework/data folder
 *                    Default: process.cwd()
 *   POLL_INTERVAL  – ms between polls while waiting   (default: 500)
 *   POLL_TIMEOUT   – ms before giving up              (default: 30000)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";

// ── config ────────────────────────────────────────────────────────────────────

const DATA_DIR      = process.env.REF_DATA_DIR   ?? process.cwd();
const POLL_INTERVAL = Number(process.env.POLL_INTERVAL ?? 500);
const POLL_TIMEOUT  = Number(process.env.POLL_TIMEOUT  ?? 30_000);

const INPUT_FILE  = path.join(DATA_DIR, "mcp_input.lua");
const OUTPUT_FILE = path.join(DATA_DIR, "mcp_output.txt");

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

/**
 * Poll INPUT_FILE until its content is empty/whitespace-only,
 * which signals that mcp_bridge.lua has consumed and executed the script.
 */
async function waitForConsumption(): Promise<void> {
  const deadline = Date.now() + POLL_TIMEOUT;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL);
    const content = await readSafe(INPUT_FILE);
    if (content.trim() === "") return;
  }

  throw new Error(
    `Timed out after ${POLL_TIMEOUT} ms waiting for mcp_bridge.lua to consume the input.\n` +
    `Make sure REFramework is running with mcp_bridge.lua in autorun/`
  );
}

// ── tool implementation ───────────────────────────────────────────────────────

async function executeCode(code: string): Promise<string> {
  // 1. Write the Lua code to the input file.
  await fs.writeFile(INPUT_FILE, code, "utf8");

  // 2. Wait for the in-game plugin to blank the file (signals execution done).
  await waitForConsumption();

  // 3. Read and return the output.
  const output = await readSafe(OUTPUT_FILE);
  return output.trim() === ""
    ? "(no output written – check REFramework logs)"
    : output;
}

// ── server setup ──────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "reframework",
  version: "1.0.0",
});

server.tool(
  "execute_code",

  "Execute Lua code inside a running RE Engine game via REFramework. " +
  "The code runs in the game process and has full access to REFramework APIs " +
  "(sdk, re, log, fs, json, imgui, draw). " +
  "Use print() to produce output; the final return value is also captured. " +
  "Requires mcp_bridge.lua loaded in reframework/autorun/.",

  {
    code: z
      .string()
      .min(1)
      .describe("Lua source code to execute inside the game"),
  },

  async ({ code }) => {
    try {
      const output = await executeCode(code);
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
    `  data dir : ${DATA_DIR}\n` +
    `  input    : ${INPUT_FILE}\n` +
    `  output   : ${OUTPUT_FILE}\n` +
    `  poll     : every ${POLL_INTERVAL} ms, timeout ${POLL_TIMEOUT} ms\n`
  );
}

main().catch((err) => {
  process.stderr.write(`[reframework-mcp] fatal: ${err}\n`);
  process.exit(1);
});
