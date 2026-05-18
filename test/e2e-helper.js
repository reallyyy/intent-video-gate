import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const APP = "http://127.0.0.1:47231/";
const APP_HEALTH = `${APP}api/health`;
const DEVTOOLS_PORTS = [9222, 9223, 9224, 9225, 9333];
const BROWSER_CANDIDATES = ["chromium", "chromium-browser", "google-chrome", "brave-browser", "brave"];
const BROWSER_PROFILE = "/tmp/intent-video-chromium-controls";
const EXTENSION_PATH = new URL("../extension", import.meta.url).pathname;

export class CdpSession {
  constructor(webSocketDebuggerUrl) {
    this.id = 1;
    this.pending = new Map();
    this.socket = new WebSocket(webSocketDebuggerUrl);
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !this.pending.has(message.id)) return;
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result || {});
    });
  }

  async open() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
  }

  call(method, params = {}) {
    const id = this.id++;
    this.socket.send(JSON.stringify({ id, method, params }));
    const response = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    return withTimeout(response, 15000, `CDP call timed out: ${method}`);
  }

  close() {
    this.socket.close();
  }
}

export async function setupE2E() {
  const cleanup = [];
  if (!await canFetch(APP_HEALTH)) {
    const app = spawn(process.execPath, ["src/index.js", "serve"], {
      cwd: new URL("..", import.meta.url).pathname,
      stdio: ["ignore", "pipe", "pipe"]
    });
    cleanup.push(() => stopProcess(app));
    await waitForFetch(APP_HEALTH, 15000, "local app server");
  }

  const browser = await browserDevtools();
  cleanup.push(browser.cleanup);
  const devtoolsUrl = browser.devtoolsUrl;

  assert.ok(await canFetch(`${devtoolsUrl}/json/version`), `Chromium DevTools endpoint is not available: ${devtoolsUrl}`);
  assert.ok(await canFetch(APP_HEALTH), `Local app server is not available: ${APP_HEALTH}`);

  return {
    appUrl: APP,
    devtoolsUrl,
    cleanup: async () => {
      for (const fn of cleanup.reverse()) await fn();
    }
  };
}

export async function openAppPage(devtoolsUrl) {
  const opened = await (await fetch(`${devtoolsUrl}/json/new?${encodeURIComponent(APP)}`, { method: "PUT" })).json();
  const page = new CdpSession(opened.webSocketDebuggerUrl);
  await page.open();
  await page.call("Page.enable");
  await page.call("Runtime.enable");
  return { opened, page };
}

export async function closeTarget(devtoolsUrl, targetId) {
  await fetch(`${devtoolsUrl}/json/close/${targetId}`).catch(() => {});
}

export async function listTargets(devtoolsUrl) {
  return await (await fetch(`${devtoolsUrl}/json/list`)).json();
}

export async function evaluate(page, expression) {
  const result = await page.call("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "Runtime.evaluate failed");
  return result.result.value;
}

export async function waitFor(page, expression, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(page, expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const diagnostics = await captureDiagnostics(page, `wait-timeout-${Date.now()}`);
  throw new Error(`Timed out waiting for: ${expression}\n${diagnostics.summary}`);
}

export async function captureDiagnostics(page, name) {
  const safeName = name.replace(/[^a-z0-9_-]/gi, "-");
  const base = `/tmp/intent-video-${safeName}`;
  const info = await evaluate(page, `(() => {
    const rectFor = (selector) => {
      const node = document.querySelector(selector);
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return {
        selector,
        width: rect.width,
        height: rect.height,
        left: rect.left,
        top: rect.top,
        display: style.display,
        visibility: style.visibility,
        opacity: style.opacity
      };
    };
    return {
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      bodyText: (document.body?.innerText || "").slice(0, 1000),
      selectors: [
        "#movie_player",
        ".html5-video-player",
        ".html5-main-video",
        "#bilibili-player",
        ".bpx-player-container",
        "[data-intent-video-focus='true']",
        "[data-intent-video-stage='true']",
        "[data-intent-video-player='true']",
        "#intent-video-panel"
      ].map(rectFor)
    };
  })()`).catch((error) => ({ error: error.message }));
  const html = await evaluate(page, "document.documentElement.outerHTML.slice(0, 200000)").catch((error) => `HTML capture failed: ${error.message}`);
  await writeFile(`${base}.json`, `${JSON.stringify(info, null, 2)}\n`, "utf8").catch(() => {});
  await writeFile(`${base}.html`, html, "utf8").catch(() => {});
  try {
    const screenshot = await page.call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await writeFile(`${base}.png`, Buffer.from(screenshot.data, "base64"));
  } catch {
    // Diagnostics are best effort.
  }
  return {
    info,
    summary: `Diagnostics: ${base}.json ${base}.html ${base}.png\nPage: ${info.url || "unknown"}\nTitle: ${info.title || "unknown"}\nReady: ${info.readyState || "unknown"}\nText: ${String(info.bodyText || info.error || "").slice(0, 400)}`
  };
}

export async function canFetch(url) {
  try {
    const response = await fetch(url);
    return response.ok;
  } catch {
    return false;
  }
}

async function discoverDevtoolsUrl() {
  const candidates = [
    process.env.CHROMIUM_DEBUG_URL,
    ...DEVTOOLS_PORTS.map((port) => `http://127.0.0.1:${port}`)
  ].filter(Boolean);

  for (const url of candidates) {
    if (await canFetch(`${url}/json/version`)) return url;
  }
  return "";
}

async function browserDevtools() {
  if (process.env.CHROMIUM_DEBUG_URL) {
    const explicit = process.env.CHROMIUM_DEBUG_URL;
    assert.ok(await canFetch(`${explicit}/json/version`), `CHROMIUM_DEBUG_URL is not available: ${explicit}`);
    return { devtoolsUrl: explicit, cleanup: async () => {} };
  }

  try {
    return await launchBrowser();
  } catch (error) {
    const discovered = await discoverDevtoolsUrl();
    if (discovered) return { devtoolsUrl: discovered, cleanup: async () => {} };
    throw error;
  }
}

async function launchBrowser() {
  const command = await findBrowserCommand();
  const port = await availableDevtoolsPort();
  const devtoolsUrl = `http://127.0.0.1:${port}`;
  const profile = await currentExtensionProfile();
  const child = spawn(command, [
    "--password-store=basic",
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    `--load-extension=${EXTENSION_PATH}`,
    APP
  ], {
    detached: true,
    stdio: "ignore"
  });
  child.unref();

  await Promise.race([
    waitForFetch(`${devtoolsUrl}/json/version`, 30000, `Chromium DevTools endpoint ${devtoolsUrl}`),
    once(child, "exit").then(([code, signal]) => {
      throw new Error(`Browser exited before DevTools became available: ${command} code=${code} signal=${signal}`);
    })
  ]);

  return {
    process: child,
    devtoolsUrl,
    cleanup: async () => {
      await stopProcess(child);
      await rm(profile, { recursive: true, force: true });
    }
  };
}

async function currentExtensionProfile() {
  const profile = await mkdtemp(join(tmpdir(), "intent-video-e2e-profile-"));
  try {
    await access(BROWSER_PROFILE);
    await cp(BROWSER_PROFILE, profile, {
      recursive: true,
      force: true,
      errorOnExist: false,
      filter: (source) => !/\/(SingletonCookie|SingletonLock|SingletonSocket|LOCK)$/.test(source)
    });
  } catch {
    // A fresh profile is still useful for tests that do not require account state.
  }
  return profile;
}

async function findBrowserCommand() {
  for (const command of BROWSER_CANDIDATES) {
    if (await commandExists(command)) return command;
  }
  throw new Error(`No browser command found. Tried: ${BROWSER_CANDIDATES.join(", ")}`);
}

async function commandExists(command) {
  const pathDirs = String(process.env.PATH || "").split(":").filter(Boolean);
  for (const dir of pathDirs) {
    try {
      await access(`${dir}/${command}`);
      return true;
    } catch {
      // Keep searching PATH.
    }
  }
  return false;
}

async function availableDevtoolsPort() {
  for (const port of DEVTOOLS_PORTS) {
    if (!await canFetch(`http://127.0.0.1:${port}/json/version`)) return port;
  }
  return 9444;
}

async function waitForFetch(url, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await canFetch(url)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${label}: ${url}`);
}

async function stopProcess(child) {
  if (!child || child.killed || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  await Promise.race([
    once(child, "exit"),
    new Promise((resolve) => setTimeout(resolve, 3000))
  ]);
  if (child.exitCode === null) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}

async function withTimeout(promise, timeoutMs, message) {
  let timeout;
  const timer = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timer]);
  } finally {
    clearTimeout(timeout);
  }
}
