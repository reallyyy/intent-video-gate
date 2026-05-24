import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { access, chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "../src/paths.js";
import { FEED_POLICY_VERSION } from "../src/store.js";

export const APP = "http://127.0.0.1:47231/";
const APP_HEALTH = `${APP}api/health`;
const DEVTOOLS_PORTS = [9222, 9223, 9224, 9225, 9333];
const BROWSER_CANDIDATES = ["chromium", "chromium-browser", "google-chrome", "brave-browser", "brave"];
const BROWSER_PROFILE = process.env.INTENT_VIDEO_E2E_PROFILE || "/tmp/intent-video-chromium-controls";
const EXTENSION_PATH = new URL("../extension", import.meta.url).pathname;
const E2E_BILIBILI_SUBTITLE_TRANSLATION = e2eTranslation("BV11w37zNEAh", [
  { from: 0, to: 600, content: "缓存中文字幕", translation: "Cached English subtitle" }
]);
const E2E_REFRESH_BILIBILI_SUBTITLE_TRANSLATION = e2eTranslation("BV1S34y1p7ZU", [
  { from: 0, to: 600, content: "刷新中文字幕", translation: "Refreshed English subtitle" }
]);
const E2E_STALE_BILIBILI_SUBTITLE_TRANSLATION = e2eTranslation("BV1Gz4y1Q7AY", [
  { from: 0, to: 600, content: "旧缓存中文字幕", translation: "Stale cached English subtitle" }
]);

function e2eTranslation(bvid, entries) {
  const sourceLastTo = entries.reduce((max, entry) => Math.max(max, Number(entry.to || 0)), 0);
  const sourceFirstFrom = entries.reduce((min, entry) => Math.min(min, Number(entry.from || 0)), Number.POSITIVE_INFINITY);
  const hash = createHash("sha256");
  for (const entry of entries) hash.update(`${Number(entry.from || 0)}\t${Number(entry.to || 0)}\t${String(entry.content || "").replace(/\s+/g, " ").trim()}\n`);
  return {
    bvid,
    translatedAt: "2026-05-22T00:00:00.000Z",
    sourceFingerprint: hash.digest("hex"),
    sourceEntryCount: entries.length,
    sourceDurationSeconds: sourceLastTo - (Number.isFinite(sourceFirstFrom) ? sourceFirstFrom : 0),
    sourceLastTo,
    entries
  };
}
const E2E_FEED = [
  {
    id: "e2e-youtube-lee-kuan-yew",
    platform: "youtube",
    title: "Lee Kuan Yew talks about China and Deng",
    uploader: "YouTube",
    durationSeconds: 276,
    thumbnail: "https://i.ytimg.com/vi/nM1f6xNfwZw/hq720.jpg",
    url: "https://www.youtube.com/watch?v=nM1f6xNfwZw"
  },
  {
    id: "e2e-bilibili-player",
    platform: "bilibili",
    title: "Bilibili subtitle E2E video",
    uploader: "Bilibili",
    durationSeconds: 465,
    thumbnail: "",
    url: "https://www.bilibili.com/video/BV11w37zNEAh",
    subtitleTranslation: E2E_BILIBILI_SUBTITLE_TRANSLATION
  }
];

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
  if (await canFetch(APP_HEALTH)) {
    cleanup.push(await seedDefaultE2EState());
  } else {
    const state = await seedE2EState();
    cleanup.push(() => rm(state.root, { recursive: true, force: true }));
    const app = spawn(process.execPath, ["src/index.js", "serve"], {
      cwd: new URL("..", import.meta.url).pathname,
      env: {
        ...process.env,
        INTENT_VIDEO_CONFIG_DIR: state.configDir,
        INTENT_VIDEO_DATA_DIR: state.dataDir
      },
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

export async function setupRefreshE2E() {
  const cleanup = [];
  const tools = await writeFakeRefreshTools();
  cleanup.push(() => rm(tools.root, { recursive: true, force: true }));

  const state = await seedE2EState({
    config: {
      gemini: {
        command: tools.gemini,
        timeoutMs: 15000,
        retries: 1
      },
      tools: {
        ytdlp: tools.ytdlp
      }
    },
    feed: [
      {
        id: "stale-youtube",
        platform: "youtube",
        title: "Stale cached video",
        uploader: "Cache",
        durationSeconds: 60,
        thumbnail: "",
        url: "https://www.youtube.com/watch?v=stale"
      },
      {
        id: "bilibili:e2e-stale",
        platform: "bilibili",
        title: "Stale Bilibili cached suggestion",
        uploader: "Cache",
        durationSeconds: 61,
        thumbnail: "https://i0.hdslb.com/bfs/archive/e2e-stale.jpg",
        url: "https://www.bilibili.com/video/BV1Gz4y1Q7AY",
        subtitleTranslation: E2E_STALE_BILIBILI_SUBTITLE_TRANSLATION
      }
    ],
    suggestions: [
      {
        id: "bilibili:e2e-stale",
        platform: "bilibili",
        title: "Stale Bilibili cached suggestion",
        uploader: "Cache",
        durationSeconds: 61,
        thumbnail: "https://i0.hdslb.com/bfs/archive/e2e-stale.jpg",
        url: "https://www.bilibili.com/video/BV1Gz4y1Q7AY",
        subtitleTranslation: E2E_STALE_BILIBILI_SUBTITLE_TRANSLATION
      }
    ]
  });
  cleanup.push(() => rm(state.root, { recursive: true, force: true }));

  const port = await availableAppPort();
  const appUrl = `http://127.0.0.1:${port}/`;
  const app = spawn(process.execPath, ["src/index.js", "serve", `--port=${port}`], {
    cwd: new URL("..", import.meta.url).pathname,
    env: {
      ...process.env,
      INTENT_VIDEO_CONFIG_DIR: state.configDir,
      INTENT_VIDEO_DATA_DIR: state.dataDir
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  cleanup.push(() => stopProcess(app));
  await waitForFetch(`${appUrl}api/health`, 15000, "isolated local app server");

  const browser = await browserDevtools();
  cleanup.push(browser.cleanup);

  return {
    appUrl,
    devtoolsUrl: browser.devtoolsUrl,
    cleanup: async () => {
      for (const fn of cleanup.reverse()) await fn();
    }
  };
}

async function seedE2EState(options = {}) {
  return seedE2EStateWith(options);
}

async function seedE2EStateWith({ config = {}, feed = E2E_FEED, suggestions = E2E_FEED }) {
  const root = await mkdtemp(join(tmpdir(), "intent-video-e2e-state-"));
  const configDir = join(root, "config");
  const dataDir = join(root, "data");
  await mkdir(configDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await writeE2EConfig(join(configDir, "config.json"), config);
  await writeE2ECache(join(dataDir, "cache.jsonl"), { feed, suggestions });
  return { root, configDir, dataDir };
}

async function seedDefaultE2EState() {
  const configBackup = await optionalRead(paths.configFile);
  const cacheBackup = await optionalRead(paths.cacheFile);
  await mkdir(paths.configDir, { recursive: true });
  await mkdir(paths.dataDir, { recursive: true });
  await writeE2EConfig(paths.configFile);
  await writeE2ECache(paths.cacheFile);
  return async () => {
    await restoreFile(paths.configFile, configBackup);
    await restoreFile(paths.cacheFile, cacheBackup);
  };
}

async function optionalRead(file) {
  try {
    return await readFile(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function restoreFile(file, backup) {
  if (backup === null) {
    await rm(file, { force: true });
    return;
  }
  await writeFile(file, backup);
}

async function writeE2EConfig(file, overrides = {}) {
  await writeFile(file, `${JSON.stringify(mergeConfig({
    filter: "allow useful live browser smoke-test videos",
    auth: {
      youtube: { status: "signedIn", updatedAt: new Date().toISOString() },
      bilibili: { status: "signedIn", updatedAt: new Date().toISOString() }
    }
  }, overrides), null, 2)}\n`, "utf8");
}

async function writeE2ECache(file, { feed = E2E_FEED, suggestions = E2E_FEED } = {}) {
  const subtitleTranslations = Object.fromEntries([...feed, ...suggestions]
    .filter((item) => item.platform === "bilibili" && item.subtitleTranslation?.entries?.length)
    .map((item) => [item.subtitleTranslation.bvid, item.subtitleTranslation]));
  subtitleTranslations[E2E_REFRESH_BILIBILI_SUBTITLE_TRANSLATION.bvid] = E2E_REFRESH_BILIBILI_SUBTITLE_TRANSLATION;
  await writeFile(file, `${JSON.stringify({
    suggestions,
    feed,
    subtitleTranslations,
    feedPolicyVersion: FEED_POLICY_VERSION,
    updatedAt: new Date().toISOString(),
    feedUpdatedAt: new Date().toISOString()
  }, null, 2)}\n`, "utf8");
}

export async function openAppPage(devtoolsUrl, appUrl = APP) {
  const opened = await (await fetch(`${devtoolsUrl}/json/new?${encodeURIComponent(appUrl)}`, { method: "PUT" })).json();
  const page = new CdpSession(opened.webSocketDebuggerUrl);
  await page.open();
  await page.call("Page.enable");
  await page.call("Runtime.enable");
  return { opened, page };
}

async function writeFakeRefreshTools() {
  const root = await mkdtemp(join(tmpdir(), "intent-video-e2e-tools-"));
  const gemini = join(root, "gemini");
  const ytdlp = join(root, "yt-dlp");
  await writeFile(gemini, `#!/usr/bin/env node
const promptIndex = process.argv.indexOf("-p");
const prompt = promptIndex >= 0 ? process.argv[promptIndex + 1] || "" : "";
const marker = "Candidates:";
if (!prompt.includes(marker)) {
  process.stdout.write(JSON.stringify({ response: JSON.stringify({ queries: ["高质量纪录片"] }) }));
  process.exit(0);
}
const candidatesText = prompt.slice(prompt.lastIndexOf(marker) + marker.length).trim();
const candidates = JSON.parse(candidatesText);
const decisions = candidates.map((candidate) => ({
  id: candidate.id,
  decision: "allow",
  confidence: 0.99,
  reason: "E2E fixture allows refresh candidates.",
  labels: ["e2e"],
  safe_title: candidate.title
}));
process.stdout.write(JSON.stringify({ response: JSON.stringify({ decisions }) }));
`, "utf8");
  await writeFile(ytdlp, `#!/usr/bin/env node
const args = process.argv.slice(2);
const target = args.find((arg) => arg.startsWith("bilisearch") || arg.includes("bilibili.com") || arg.includes("youtube.com")) || "";
const youtubeItems = [
  {
    id: "yt-refresh-1",
    title: "YouTube refreshed E2E video one",
    uploader: "YouTube",
    duration: 276,
    thumbnail: "https://i.ytimg.com/vi/yt-refresh-1/hq720.jpg",
    webpage_url: "https://www.youtube.com/watch?v=yt-refresh-1"
  },
  {
    id: "yt-refresh-2",
    title: "YouTube refreshed E2E video two",
    uploader: "YouTube",
    duration: 388,
    thumbnail: "https://i.ytimg.com/vi/yt-refresh-2/hq720.jpg",
    webpage_url: "https://www.youtube.com/watch?v=yt-refresh-2"
  }
];
const bilibiliItems = [
  {
    id: "BV1S34y1p7ZU",
    title: "Bilibili refreshed E2E video",
    uploader: "Bilibili",
    duration: 465,
    thumbnail: "https://i0.hdslb.com/bfs/archive/e2e-refresh.jpg",
    webpage_url: "https://www.bilibili.com/video/BV1S34y1p7ZU"
  }
];
if (args.includes("--flat-playlist")) {
  const items = target.includes("bilibili.com") || target.startsWith("bilisearch") ? bilibiliItems : youtubeItems;
  process.stdout.write(items.map((item) => JSON.stringify(item)).join("\\n") + "\\n");
  process.exit(0);
}
const item = target.includes("bilibili.com")
  ? bilibiliItems[0]
  : youtubeItems[0];
process.stdout.write(JSON.stringify(item) + "\\n");
`, "utf8");
  await chmod(gemini, 0o755);
  await chmod(ytdlp, 0o755);
  return { root, gemini, ytdlp };
}

function mergeConfig(base, override) {
  const out = { ...base, ...override };
  for (const key of ["auth", "gemini", "tools", "viewer", "suggestions", "policy"]) {
    if (base[key] || override[key]) out[key] = { ...(base[key] || {}), ...(override[key] || {}) };
  }
  return out;
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
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      if (await evaluate(page, expression)) return;
      lastError = null;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const diagnostics = await captureDiagnostics(page, `wait-timeout-${Date.now()}`);
  const reason = lastError ? `\nLast evaluation error: ${lastError.message}` : "";
  throw new Error(`Timed out waiting for: ${expression}${reason}\n${diagnostics.summary}`);
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
  const { path: profile, owned } = await currentExtensionProfile();
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
      if (owned) await rm(profile, { recursive: true, force: true });
    }
  };
}

async function currentExtensionProfile() {
  if (process.env.INTENT_VIDEO_E2E_PROFILE) {
    try {
      await access(BROWSER_PROFILE);
      console.error(`# Using Chromium E2E profile directly: ${BROWSER_PROFILE}`);
      return { path: BROWSER_PROFILE, owned: false };
    } catch {
      console.error(`# INTENT_VIDEO_E2E_PROFILE not found: ${BROWSER_PROFILE}, using fresh profile`);
    }
  }
  const profile = await mkdtemp(join(tmpdir(), "intent-video-e2e-profile-"));
  try {
    await access(BROWSER_PROFILE);
    console.error(`# Using Chromium E2E profile seed: ${BROWSER_PROFILE}`);
    await cp(BROWSER_PROFILE, profile, {
      recursive: true,
      force: true,
      errorOnExist: false,
      filter: (source) => !/\/(SingletonCookie|SingletonLock|SingletonSocket|LOCK)$/.test(source)
    });
  } catch {
    // A fresh profile is still useful for tests that do not require account state.
  }
  return { path: profile, owned: true };
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

async function availableAppPort() {
  for (const port of [47232, 47233, 47234, 47235, 47236]) {
    if (!await canFetch(`http://127.0.0.1:${port}/api/health`)) return port;
  }
  return 47237;
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
