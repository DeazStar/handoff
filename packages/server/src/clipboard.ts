import { execFile, spawn } from "node:child_process";

/** The computer's clipboard. A password is copied from the server, so it never has to be sent to the page or to Claude. */
export interface Clipboard {
  write(text: string): Promise<void>;
  read(): Promise<string>;
}

function run(cmd: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (input !== undefined) {
      const p = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] });
      p.on("error", reject);
      p.on("close", (code) => (code === 0 ? resolve("") : reject(new Error(`${cmd} failed`))));
      p.stdin.end(input);
    } else {
      execFile(cmd, args, (err, out) => (err ? reject(err) : resolve(out)));
    }
  });
}

/** macOS, Linux (wl-copy or xclip) and Windows. Throws a plain message when there is no clipboard tool. */
export function systemClipboard(): Clipboard {
  const mac = process.platform === "darwin";
  const win = process.platform === "win32";
  const unavailable = () => new Error("Copying is not available on this computer");
  return {
    async write(text) {
      try {
        if (mac) await run("pbcopy", [], text);
        else if (win) await run("clip", [], text);
        else {
          try { await run("wl-copy", [], text); } catch { await run("xclip", ["-selection", "clipboard"], text); }
        }
      } catch {
        throw unavailable();
      }
    },
    async read() {
      try {
        if (mac) return await run("pbpaste", []);
        if (win) return await run("powershell", ["-command", "Get-Clipboard"]);
        try { return await run("wl-paste", []); } catch { return await run("xclip", ["-selection", "clipboard", "-o"]); }
      } catch {
        throw unavailable();
      }
    },
  };
}
