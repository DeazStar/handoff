import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  dataDir: string;
  dbPath: string;
  token: string;
  port: number;
}

/** Data lives in ~/.jobhunt (override with JOBHUNT_HOME). The token is created once and kept private. */
export function loadConfig(env = process.env): Config {
  const dataDir = env.JOBHUNT_HOME ?? join(homedir(), ".jobhunt");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const tokenPath = join(dataDir, "dashboard-token");
  if (!existsSync(tokenPath)) {
    writeFileSync(tokenPath, randomBytes(32).toString("hex"), { mode: 0o600 });
  }
  chmodSync(tokenPath, 0o600);
  return {
    dataDir,
    dbPath: env.JOBHUNT_DB ?? join(dataDir, "jobhunt.db"),
    token: readFileSync(tokenPath, "utf8").trim(),
    port: Number(env.JOBHUNT_PORT ?? 4317),
  };
}
