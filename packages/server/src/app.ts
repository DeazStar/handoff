import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { FACT_KINDS, TransitionError, createHumanApi, type DB, type JobState } from "@jobhunt/core";

const PUBLIC = new URL("../public/", import.meta.url);
const STATIC: Record<string, [string, string]> = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/styles.css": ["styles.css", "text/css; charset=utf-8"],
};
const COOKIE = "jh_token";
const MAX_BODY = 1_000_000;

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

function readCookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

async function readJson(req: IncomingMessage): Promise<any> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "Request too large");
    chunks.push(c as Buffer);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Body is not valid JSON");
  }
}

function send(res: ServerResponse, status: number, body: unknown, type = "application/json; charset=utf-8") {
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    // Job titles and descriptions come from the internet: no inline script, no external anything.
    "content-security-policy":
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

/** Maps what core throws to an HTTP status. Crude by design: unknown errors become 500, never 4xx. */
function statusFor(e: unknown): [number, string] {
  if (e instanceof HttpError) return [e.status, e.message];
  if (e instanceof TransitionError) return [409, e.message];
  if (e instanceof TypeError || e instanceof RangeError || e instanceof SyntaxError) {
    console.error(e);
    return [500, "Internal error"];
  }
  const code = (e as { code?: string })?.code;
  if (e instanceof Error && (code?.startsWith("SQLITE_CONSTRAINT") || !code)) {
    return [/not found/i.test(e.message) ? 404 : 400, e.message];
  }
  console.error(e);
  return [500, "Internal error"];
}

const int = (s: string) => {
  const n = Number(s);
  if (!Number.isInteger(n)) throw new HttpError(400, "Bad id");
  return n;
};

export function createApp(db: DB, opts: { token: string }): Server {
  const human = createHumanApi(db);

  type Handler = (m: RegExpMatchArray, body: any, url: URL) => unknown;
  const routes: [string, RegExp, Handler][] = [];
  const route = (method: string, path: string, h: Handler) =>
    routes.push([method, new RegExp(`^${path}$`), h]);

  route("GET", "/api/actions", () => human.listActionsDetailed());
  route("POST", "/api/actions/(\\d+)/resolve", (m, b) => {
    if (b.status !== "done" && b.status !== "dismissed") throw new HttpError(400, "status must be done or dismissed");
    human.resolveAction(int(m[1]!), b.status);
    return { ok: true };
  });
  route("POST", "/api/actions/(\\d+)/confirm-gap", (m, b) => {
    if (b.scope !== "job" && b.scope !== "general") throw new HttpError(400, "scope must be job or general");
    if (!b.fact || !FACT_KINDS.includes(b.fact.kind)) throw new HttpError(400, "fact.kind is invalid");
    const { kind, text, dateRange } = b.fact;
    return { factId: human.confirmGap(int(m[1]!), { kind, text: String(text ?? ""), dateRange }, b.scope) };
  });

  route("GET", "/api/jobs", (_m, _b, url) => human.listJobs((url.searchParams.get("state") as JobState) ?? undefined));
  route("GET", "/api/jobs/(\\d+)", (m) => {
    const id = int(m[1]!);
    const detail = human.getJob(id);
    if (!detail) throw new HttpError(404, "Job not found");
    return {
      ...detail,
      documents: human.listDocuments(id),
      actions: human.listActionsDetailed().filter((a) => a.jobId === id),
      allowedTransitions: human.allowedTransitions(detail.job.state),
    };
  });
  route("POST", "/api/jobs/(\\d+)/transition", (m, b) => {
    human.transitionJob(int(m[1]!), b.to, typeof b.reason === "string" ? b.reason : undefined);
    return { ok: true };
  });

  route("GET", "/api/facts", () => human.listFacts());
  route("POST", "/api/facts", (_m, b) => ({ id: human.addFact(b) }));
  route("PUT", "/api/facts/(\\d+)", (m, b) => (human.updateFact(int(m[1]!), b), { ok: true }));
  route("DELETE", "/api/facts/(\\d+)", (m) => (human.deleteFact(int(m[1]!)), { ok: true }));
  route("POST", "/api/facts/(\\d+)/make-general", (m) => (human.makeFactGeneral(int(m[1]!)), { ok: true }));

  route("GET", "/api/profile", () => human.getProfile());
  route("PUT", "/api/profile", (_m, b) => (human.setProfile(b), { ok: true }));
  route("GET", "/api/preferences", () => human.getPreferences());
  route("PUT", "/api/preferences", (_m, b) => (human.setPreferences(b), { ok: true }));
  route("GET", "/api/sources/stats", () => human.sourceStats());
  route("GET", "/api/documents/(\\d+)", (m) => {
    const d = human.getDocument(int(m[1]!));
    if (!d) throw new HttpError(404, "Document not found");
    return d;
  });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const server = req.socket.localPort;
    const host = req.headers.host;
    // Blocks DNS-rebinding: a hostile site pointing its own name at 127.0.0.1 would send another Host.
    if (host !== `127.0.0.1:${server}` && host !== `localhost:${server}`) throw new HttpError(403, "Bad host");

    const url = new URL(req.url ?? "/", `http://${host}`);
    const method = req.method ?? "GET";

    // First visit: ?token=... sets a cookie and redirects to the clean URL.
    const qt = url.searchParams.get("token");
    if (method === "GET" && url.pathname === "/" && qt !== null && safeEqual(qt, opts.token)) {
      res.writeHead(302, {
        location: "/",
        "set-cookie": `${COOKIE}=${opts.token}; HttpOnly; SameSite=Strict; Path=/`,
        "cache-control": "no-store",
      });
      return res.end();
    }

    const bearer = req.headers.authorization?.replace(/^Bearer /, "");
    const supplied = bearer ?? readCookie(req, COOKIE) ?? "";
    if (!safeEqual(supplied, opts.token)) {
      if (url.pathname.startsWith("/api/")) throw new HttpError(401, "Unauthorized");
      return send(res, 401, "Open the dashboard with the link printed when it started.", "text/plain; charset=utf-8");
    }

    const origin = req.headers.origin;
    if (origin !== undefined && origin !== `http://${host}`) throw new HttpError(403, "Bad origin");

    if (method === "GET" && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname]!;
      return send(res, 200, await readFile(new URL(file, PUBLIC), "utf8"), type);
    }

    if (!url.pathname.startsWith("/api/")) throw new HttpError(404, "Not found");
    let body: any = {};
    if (method !== "GET") {
      // Requiring JSON forces browsers to preflight any cross-site request, which we never approve.
      if (!/^application\/json\b/.test(req.headers["content-type"] ?? "")) {
        throw new HttpError(415, "Content-Type must be application/json");
      }
      body = await readJson(req);
    }
    for (const [m, re, h] of routes) {
      if (m !== method) continue;
      const match = url.pathname.match(re);
      if (match) return send(res, 200, h(match, body, url) ?? null);
    }
    throw new HttpError(404, "Not found");
  }

  return createServer((req, res) => {
    handle(req, res).catch((e) => {
      const [status, message] = statusFor(e);
      send(res, status, { error: message });
    });
  });
}
