// Copies the repo-level lua/mcp.lua next to the compiled server so the built
// output can install the bridge even without the repository layout.
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.resolve(here, "..", "..", "lua", "mcp.lua");
const target = path.resolve(here, "..", "dist", "mcp.lua");

mkdirSync(path.dirname(target), { recursive: true });
copyFileSync(source, target);
console.log(`[build] copied ${source} -> ${target}`);
