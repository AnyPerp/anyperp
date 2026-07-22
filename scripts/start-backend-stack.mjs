/**
 * Single-process supervisor for Railway free-plan (one service slot).
 * Starts API + indexer + keepers (+ optional oracle + private admin).
 *
 * Env:
 *   STACK_ENABLE_ORACLE=true  — pyth-push loop
 *   ADMIN_PASSWORD=...        — enable private admin (not public FE)
 *   PORT / HOST               — public listen (proxy)
 *
 * When ADMIN_PASSWORD is set and private/admin-dashboard exists:
 *   - API listens on 127.0.0.1:4001
 *   - Admin listens on 127.0.0.1:4100
 *   - Supervisor proxies public PORT:
 *       /_admin/*   → admin UI
 *       /admin-api/* → admin API (+ SSE stream)
 *       everything else → API
 */
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const adminDir = path.join(root, "private", "admin-dashboard");
const adminServer = path.join(adminDir, "server.mjs");

const children = new Map();
let shuttingDown = false;

function pipe(name, child) {
  child.stdout?.on("data", (buf) => process.stdout.write(`[${name}] ${buf}`));
  child.stderr?.on("data", (buf) => process.stderr.write(`[${name}] ${buf}`));
}

function startCritical(name, command, args, env = process.env) {
  const child = spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env,
    shell: true,
    cwd: root,
  });
  pipe(name, child);
  children.set(name, child);
  child.on("exit", (code, signal) => {
    console.error(`[${name}] exited code=${code} signal=${signal}`);
    if (!shuttingDown) process.exit(code ?? 1);
  });
  console.log(JSON.stringify({ service: "anyperp-stack", started: name, pid: child.pid, role: "critical" }));
}

function startOptional(name, command, args, env = process.env) {
  let attempt = 0;
  const run = () => {
    if (shuttingDown) return;
    attempt += 1;
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env,
      shell: true,
      cwd: root,
    });
    pipe(name, child);
    children.set(name, child);
    console.log(JSON.stringify({
      service: "anyperp-stack",
      started: name,
      pid: child.pid,
      role: "optional",
      attempt,
    }));
    child.on("exit", (code, signal) => {
      console.error(`[${name}] exited code=${code} signal=${signal}; will restart`);
      children.delete(name);
      if (shuttingDown) return;
      const delay = Math.min(60_000, 2_000 * attempt);
      setTimeout(run, delay).unref?.();
    });
  };
  run();
}

const publicPort = Number(process.env.PORT || 4000);
const publicHost = process.env.HOST || "0.0.0.0";
const adminEnabled =
  Boolean(process.env.ADMIN_PASSWORD && process.env.ADMIN_PASSWORD.length >= 8) &&
  fs.existsSync(adminServer);

const apiPort = adminEnabled ? 4001 : publicPort;
const apiHost = adminEnabled ? "127.0.0.1" : publicHost;

const apiEnv = {
  ...process.env,
  HOST: apiHost,
  PORT: String(apiPort),
};

startCritical("api", "pnpm", ["exec", "tsx", "services/api/src/server.ts"], apiEnv);
startCritical("indexer", "pnpm", ["exec", "tsx", "services/indexer/src/indexer.ts"]);
startCritical("keepers", "pnpm", ["exec", "tsx", "services/keepers/src/worker.ts"]);

if (process.env.STACK_ENABLE_ORACLE === "true") {
  startOptional("oracle", "pnpm", ["oracle:push:loop"]);
} else {
  console.log(JSON.stringify({ service: "anyperp-stack", oracle: "disabled" }));
}

if (adminEnabled) {
  const adminEnv = {
    ...process.env,
    ADMIN_BIND: "127.0.0.1",
    PORT: "4100",
    ADMIN_PORT: "4100",
    ADMIN_SECURE_COOKIE: process.env.ADMIN_SECURE_COOKIE || "true",
    ADMIN_METRICS_POLL_MS: process.env.ADMIN_METRICS_POLL_MS || "5000",
  };
  startOptional("admin", "node", [adminServer], adminEnv);

  /** @param {import('node:http').IncomingMessage} req */
  /** @param {import('node:http').ServerResponse} res */
  function proxy(req, res, targetPort, stripPrefix = "") {
    const rawUrl = req.url || "/";
    let pathWithQuery = rawUrl;
    if (stripPrefix && pathWithQuery.startsWith(stripPrefix)) {
      pathWithQuery = pathWithQuery.slice(stripPrefix.length) || "/";
      if (!pathWithQuery.startsWith("/")) pathWithQuery = `/${pathWithQuery}`;
    }
    const headers = { ...req.headers, host: `127.0.0.1:${targetPort}` };
    const preq = http.request(
      {
        hostname: "127.0.0.1",
        port: targetPort,
        path: pathWithQuery,
        method: req.method,
        headers,
      },
      (pres) => {
        res.writeHead(pres.statusCode || 502, pres.headers);
        pres.pipe(res);
      },
    );
    preq.on("error", (err) => {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "proxy_upstream", detail: err.message }));
    });
    req.pipe(preq);
  }

  const proxyServer = http.createServer((req, res) => {
    const url = req.url || "/";
    // Public entry (via www.anyperp.fun proxy) — no underscores (some CDNs 404 `_` paths)
    if (url === "/admin-ui" || url.startsWith("/admin-ui/") || url.startsWith("/admin-ui?")) {
      return proxy(req, res, 4100, "/admin-ui");
    }
    // Legacy path kept for direct Railway access
    if (url === "/_admin" || url.startsWith("/_admin/") || url.startsWith("/_admin?")) {
      return proxy(req, res, 4100, "/_admin");
    }
    if (url.startsWith("/admin-api")) {
      return proxy(req, res, 4100);
    }
    return proxy(req, res, apiPort);
  });

  // Wait briefly for children, then listen
  setTimeout(() => {
    proxyServer.listen(publicPort, publicHost, () => {
      console.log(JSON.stringify({
        service: "anyperp-stack",
        proxy: true,
        listen: `${publicHost}:${publicPort}`,
        api: `${apiHost}:${apiPort}`,
        admin: "127.0.0.1:4100",
        adminPath: "/admin-ui/",
        note: "Private admin password-gated; not linked from public frontend",
      }));
    });
  }, 1500);
} else {
  console.log(JSON.stringify({
    service: "anyperp-stack",
    admin: "disabled",
    hint: "Set ADMIN_PASSWORD (8+) and ship private/admin-dashboard in image to enable",
  }));
}

function shutdown() {
  shuttingDown = true;
  for (const child of children.values()) {
    try {
      child.kill("SIGTERM");
    } catch {
      // ignore
    }
  }
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
