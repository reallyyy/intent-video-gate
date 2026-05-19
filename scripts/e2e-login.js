#!/usr/bin/env node
import { access, cp, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";

const BROWSER_CANDIDATES = ["chromium", "chromium-browser", "google-chrome", "brave-browser", "brave"];
const SNAP_PROFILES = {
  chromium: join(homedir(), "snap", "chromium", "common", "chromium"),
  firefox: join(homedir(), "snap", "firefox", "common", ".mozilla", "firefox")
};
const XDG_PROFILES = {
  chromium: join(homedir(), ".config", "chromium"),
  "google-chrome": join(homedir(), ".config", "google-chrome"),
  brave: join(homedir(), ".config", "BraveSoftware", "Brave-Browser"),
  firefox: join(homedir(), ".mozilla", "firefox")
};
const EXTENSION_PATH = new URL("../extension", import.meta.url).pathname;
const APP_URL = "http://127.0.0.1:47231";
const PORT = 9229;

async function main() {
  const command = await findBrowser();
  const detectedProfile = await detectProfile(command);

  if (detectedProfile) {
    console.log(`Found ${command} profile at ${detectedProfile}`);
    console.log("");
    console.log("To run E2E tests with this profile:");
    console.log(`  INTENT_VIDEO_E2E_PROFILE=${detectedProfile} npm test`);
    console.log("");

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise((resolve) => {
      rl.question("Already logged into YouTube and Bilibili? (Y/n) ", (a) => {
        rl.close();
        resolve(a.trim().toLowerCase());
      });
    });
    if (answer !== "n" && answer !== "no") {
      console.log("Run the command above to start E2E tests.");
      return;
    }
  }

  const profile = await mkdtemp(join(tmpdir(), "intent-video-login-"));
  console.log(`Launching ${command} for login...`);
  console.log("1. Log into YouTube and Bilibili");
  console.log("2. Press Enter when done");
  console.log("");

  const child = spawn(command, [
    "--password-store=basic",
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    `--load-extension=${EXTENSION_PATH}`,
    APP_URL
  ], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  child.unref();
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});

  await waitForDevtools(PORT);

  const rl2 = createInterface({ input: process.stdin, output: process.stdout });
  await new Promise((resolve) => {
    rl2.question("Press Enter after logging in... ", () => {
      rl2.close();
      resolve();
    });
  });

  console.log("Stopping browser...");
  try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
  await Promise.race([
    once(child, "exit"),
    new Promise((resolve) => setTimeout(resolve, 8000))
  ]);
  if (child.exitCode === null) {
    try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  }
  await new Promise((resolve) => setTimeout(resolve, 2000));

  const savedProfile = detectedProfile || join(tmpdir(), "intent-video-chromium-controls");
  await rm(savedProfile, { recursive: true, force: true }).catch(() => {});
  await mkdir(savedProfile, { recursive: true });
  await cp(profile, savedProfile, {
    recursive: true,
    force: true,
    errorOnExist: false,
    filter: (source) => !/\/(SingletonCookie|SingletonLock|SingletonSocket|LOCK)$/.test(source)
  });
  await rm(profile, { recursive: true, force: true });

  console.log(`Profile saved to ${savedProfile}`);
  console.log("");
  console.log("Run E2E tests with:");
  console.log(`  INTENT_VIDEO_E2E_PROFILE=${savedProfile} npm test`);
}

async function findBrowser() {
  for (const candidate of BROWSER_CANDIDATES) {
    if (await commandExists(candidate)) return candidate;
  }
  throw new Error(`No browser found. Tried: ${BROWSER_CANDIDATES.join(", ")}`);
}

async function commandExists(command) {
  return new Promise((resolve) => {
    const child = spawn("which", [command], { timeout: 5000 });
    child.on("close", (code) => resolve(code === 0));
  });
}

async function detectProfile(command) {
  const snap = SNAP_PROFILES[command];
  if (snap && await dirExists(snap)) return snap;
  const xdg = XDG_PROFILES[command];
  if (xdg && await dirExists(xdg)) return xdg;
  return null;
}

async function dirExists(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function waitForDevtools(port) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`DevTools not available on port ${port} after 30s`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
