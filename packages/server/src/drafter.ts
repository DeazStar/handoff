import { spawn, execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** Where the Claude Code command is: JOBHUNT_CLAUDE, then the PATH, then the copy the Claude desktop app keeps. */
export function findClaude(env: NodeJS.ProcessEnv = process.env, home = homedir()): string | null {
  if (env.JOBHUNT_CLAUDE && existsSync(env.JOBHUNT_CLAUDE)) return env.JOBHUNT_CLAUDE;
  try {
    const p = execFileSync("/usr/bin/which", ["claude"], { encoding: "utf8", env }).trim();
    if (p) return p;
  } catch { /* not on the PATH */ }
  const root = join(home, "Library", "Application Support", "Claude", "claude-code");
  try {
    const versions = readdirSync(root).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const v of versions) {
      for (const sub of readdirSync(join(root, v))) {
        const bin = join(root, v, sub, "claude.app", "Contents", "MacOS", "claude");
        if (existsSync(bin)) return bin;
      }
    }
  } catch { /* the desktop app is not installed */ }
  return null;
}

/** The only things a drafting run may do: read the job and the user's facts, and write drafts. No browser, no shell, no files. */
export const DRAFT_TOOLS = [
  "list_gap_draft_requests", "draft_gap", "list_gap_polish_requests", "polish_gap", "get_job", "get_job_description", "get_cv_material", "list_facts",
].map((t) => `mcp__jobhunt__${t}`);

export interface DrafterOptions {
  /** The jobhunt MCP server's entry file. */
  mcpMain: string;
  /** The text of the /gaps command: what to do with each request. */
  prompt: string;
  /** Environment for the MCP server: which database and data folder it uses. */
  mcpEnv: Record<string, string>;
  claudePath?: string | null;
  /** For tests: replaces starting the Claude command. Resolves with an error text, or null when it finished. */
  run?: (prompt: string) => Promise<string | null>;
  timeoutMs?: number;
}

export interface DrafterStatus { available: boolean; running: boolean; error: string | null; finishedAt: string | null }

/** Runs one drafting pass at a time by starting Claude Code in the background, limited to the tools above. */
export function createDrafter(opts: DrafterOptions) {
  const claude = opts.claudePath === undefined ? findClaude() : opts.claudePath;
  let running = false;
  let error: string | null = null;
  let finishedAt: string | null = null;

  const runClaude = (prompt: string): Promise<string | null> => new Promise((resolve) => {
    const dir = mkdtempSync(join(tmpdir(), "jobhunt-draft-"));
    const cfg = join(dir, "mcp.json");
    writeFileSync(cfg, JSON.stringify({ mcpServers: { jobhunt: { command: process.execPath, args: [opts.mcpMain], env: opts.mcpEnv } } }));
    const done = (msg: string | null) => { rmSync(dir, { recursive: true, force: true }); resolve(msg); };
    // --tools "" removes Claude's own tools (shell, files, browser); only the listed jobhunt tools remain.
    const child = spawn(claude!, ["-p", prompt, "--strict-mcp-config", "--mcp-config", cfg, "--tools", "", "--allowedTools", ...DRAFT_TOOLS, "--permission-mode", "dontAsk", "--no-session-persistence"], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    let tail = "";
    const keep = (b: Buffer) => { tail = (tail + b.toString()).slice(-600); };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = setTimeout(() => { child.kill(); done("Claude took too long (over " + Math.round((opts.timeoutMs ?? 300_000) / 60_000) + " minutes) and was stopped."); }, opts.timeoutMs ?? 300_000);
    child.on("error", (e) => { clearTimeout(timer); done(`Could not start Claude: ${e.message}`); });
    child.on("close", (code) => { clearTimeout(timer); done(code === 0 ? null : `Claude stopped with an error: ${tail.trim().split("\n").slice(-3).join(" ") || `exit code ${code}`}`); });
  });

  return {
    status: (): DrafterStatus => ({ available: Boolean(opts.run) || Boolean(claude), running, error, finishedAt }),
    /** Starts a pass unless one is already running. Returns false when Claude is not installed. */
    start(): boolean {
      if (!opts.run && !claude) return false;
      if (running) return true;
      running = true;
      error = null;
      void (opts.run ? opts.run(opts.prompt) : runClaude(opts.prompt)).then((e) => { error = e; }, (e: Error) => { error = e.message; }).finally(() => {
        running = false;
        finishedAt = new Date().toISOString();
      });
      return true;
    },
  };
}

export type Drafter = ReturnType<typeof createDrafter>;

/** The /gaps command's instructions without its header, so the dashboard and the command do the same thing. */
export function readGapsPrompt(file: string): string {
  try {
    return readFileSync(file, "utf8").replace(/^---[\s\S]*?---\s*/, "").trim();
  } catch {
    return "Call list_gap_draft_requests and list_gap_polish_requests. For each draft request, read the job and the user's facts, then call draft_gap with a draft written only from those facts, or with no draft and a note when nothing backs it. For each polish request, call polish_gap with the user's own text reworded to read better, adding nothing. Never invent anything.";
  }
}
