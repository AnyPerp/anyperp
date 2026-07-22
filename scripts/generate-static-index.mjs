/**
 * After vinext build, start a short-lived production server, capture HTML, write
 * dist/client/index.html so static hosts (Vercel/Pages) can serve the app shell.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const port = Number(process.env.STATIC_CAPTURE_PORT ?? 4567);
const out = path.join("dist", "client", "index.html");
const clientDir = path.join("dist", "client");

if (!fs.existsSync(path.join("dist", "server", "index.js"))) {
  console.error("dist/server missing; run pnpm build first");
  process.exit(1);
}

/** Ensure nested public assets ship to static hosts (logo/, banner/). */
function copyPublicSubtree(rel) {
  const src = path.join("public", rel);
  const dest = path.join(clientDir, rel);
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
  console.log(`copied public/${rel} → dist/client/${rel}`);
}
copyPublicSubtree("logo");
copyPublicSubtree("banner");
// Keep root public files in sync if the build omitted any
for (const name of fs.readdirSync("public", { withFileTypes: true })) {
  if (name.isDirectory()) continue;
  const dest = path.join(clientDir, name.name);
  if (!fs.existsSync(dest)) {
    fs.copyFileSync(path.join("public", name.name), dest);
    console.log(`copied public/${name.name}`);
  }
}

const child = spawn(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["cross-env", `PORT=${port}`, "HOST=127.0.0.1", "WRANGLER_LOG_PATH=.wrangler/wrangler.log", "vinext", "start"],
  {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1" },
    shell: process.platform === "win32",
  },
);

let ready = false;
const onData = (buf) => {
  const text = buf.toString();
  process.stdout.write(text);
  if (/localhost|Local:|ready|listening/i.test(text)) ready = true;
};
child.stdout?.on("data", onData);
child.stderr?.on("data", onData);

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

try {
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        headers: { accept: "text/html" },
      });
      if (!res.ok) continue;
      const html = await res.text();
      if (!html.includes("<html") && !html.includes("<!DOCTYPE")) continue;
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, html);
      console.log(`wrote ${out} (${html.length} bytes)`);
      process.exitCode = 0;
      break;
    } catch {
      // retry
    }
  }
  if (!fs.existsSync(out)) {
    console.error("failed to capture index.html from vinext start");
    process.exitCode = 1;
  }
} finally {
  child.kill("SIGTERM");
  setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* ignore */
    }
    process.exit(process.exitCode ?? 0);
  }, 2000).unref();
}
