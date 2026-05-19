#!/usr/bin/env node
import { access, cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";

const BROWSER_CANDIDATES = ["chromium", "chromium-browser", "google-chrome", "brave-browser", "brave"];
const PROFILE_DIR = process.env.INTENT_VIDEO_E2E_PROFILE || join(tmpdir(), "intent-video-chromium-controls");
const EXTENSION_PATH = new URL("../extension", import.meta.url).pathname;
const APP_URL = "http://127.0.0.1:47231";
const PORT = 9229;

async function main() {
  const command = await findBrowser();
  const profile = await prepareProfile();

  console.log(`Launching ${command} with remote debugging on port ${PORT}`);
  console.log(`Profile: ${profile}`);
  console.log(`Saving to: ${PROFILE_DIR}`);
  console.log("");
  console.log("1. Log into YouTube and Bilibili in the browser window");
  console.log("2. Press Enter in this terminal when done");
  console.log("");

  const child = spawn(command, [
    "--password-store=basic",
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    `--load-extension=${EXTENSION_PATH}`,
    APP_URL
  ], { detached: true, stdio: "ignore" });
  child.unref();

  await waitForDevtools(PORT);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await new Promise((resolve) => {
    rl.question("Press Enter after logging in to save the profile...", () => {
      rl.close();
      resolve();
    });
  });

  console.log("Stopping browser...");
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  await Promise.race([
    once(child, "exit"),
    new Promise((resolve) => setTimeout(resolve, 5000))
  ]);
  if (child.exitCode === null) {
    try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  }

  await saveProfile(profile);
  await rm(profile, { recursive: true, force: true });
  console.log("Done. E2E tests will now use the logged-in profile.");
}

async function findBrowser() {
  for (const candidate of BROWSER_CANDIDATES) {
    try {
      const { stdout } = await import("node:child_process").then(m => {
        return new Promise((resolve) => {
          const child = spawn("which", [candidate], { timeout: 5000 });
          let out = "";
          child.stdout.on("data", (d) => out += d);
          child.on("close", (code) => resolve({ stdout: out, code }));
        });
      });
      if (stdout.trim()) return candidate;
    } catch {}
  }
  throw new Error(`No browser found. Tried: ${BROWSER_CANDIDATES.join(", ")}`);
}

async function prepareProfile() {
  const profile = await mkdtemp(join(tmpdir(), "intent-video-login-"));
  try {
    await access(PROFILE_DIR);
    console.log(`Copying existing profile from ${PROFILE_DIR}`);
    await cp(PROFILE_DIR, profile, {
      recursive: true,
      force: true,
      errorOnExist: false,
      filter: (source) => !/\/(SingletonCookie|SingletonLock|SingletonSocket|LOCK)$/.test(source)
    });
  } catch {
    console.log("Starting with a fresh profile");
  }
  return profile;
}

async function saveProfile(profile) {
  await mkdir(PROFILE_DIR, { recursive: true });
  await cp(profile, PROFILE_DIR, {
    recursive: true,
    force: true,
    errorOnExist: false,
    filter: (source) => !/\/(SingletonCookie|SingletonLock|SingletonSocket|LOCK)$/.test(source)
  });
  console.log(`Profile saved to ${PROFILE_DIR}`);
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
