#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { openDb, resolveDataPaths } from "@jobhunt/core/agent";
import { createMcpServer } from "./server.js";

// stdout carries the protocol. Anything else written there would corrupt it, so logging goes to stderr.
console.log = console.error;
console.info = console.error;

const { dataDir, dbPath } = resolveDataPaths();
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const db = openDb(dbPath);

await createMcpServer(db, { dataDir }).connect(new StdioServerTransport());
console.error(`jobhunt MCP server ready (database: ${dbPath})`);

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
