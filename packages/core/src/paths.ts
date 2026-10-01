import { homedir } from "node:os";
import { join } from "node:path";

/** Where the data lives. Every process (dashboard, MCP server) must resolve it the same way. */
export function resolveDataPaths(env: NodeJS.ProcessEnv = process.env): { dataDir: string; dbPath: string } {
  const dataDir = env.JOBHUNT_HOME ?? join(homedir(), ".jobhunt");
  return { dataDir, dbPath: env.JOBHUNT_DB ?? join(dataDir, "jobhunt.db") };
}
