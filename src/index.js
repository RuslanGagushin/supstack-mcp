#!/usr/bin/env node
/* supstack-mcp: an MCP server (stdio) for a Supstack vault.
     supstack-mcp <vault folder> [--read-only]
   The folder can also come from the SUPSTACK_VAULT environment variable. */
import fs from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, VERSION } from "./server.js";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log("Usage: supstack-mcp <vault folder> [--read-only]\n\nThe vault folder can also be given in SUPSTACK_VAULT. --read-only (or SUPSTACK_READ_ONLY=1) leaves out the tools that change the vault.");
  process.exit(0);
}
if (args.includes("--version") || args.includes("-v")) { console.log(VERSION); process.exit(0); }
const unknown = args.find((a) => a.startsWith("--") && a !== "--read-only");
if (unknown) { console.error(`supstack-mcp: unknown option ${unknown}`); process.exit(2); }
const readOnly = args.includes("--read-only") || /^(1|true|yes)$/i.test(process.env.SUPSTACK_READ_ONLY || "");
const root = args.find((a) => !a.startsWith("--")) || process.env.SUPSTACK_VAULT;
if (!root) { console.error("supstack-mcp: give the vault folder as an argument or in SUPSTACK_VAULT."); process.exit(2); }
let isDir = false;
try { isDir = fs.statSync(root).isDirectory(); } catch { /* not there */ }
if (!isDir) { console.error(`supstack-mcp: ${root} is not a folder.`); process.exit(2); }

const { server } = createServer(root, { readOnly });
await server.connect(new StdioServerTransport());
console.error(`supstack-mcp ${VERSION}: serving ${root}${readOnly ? " (read-only)" : ""}`);
