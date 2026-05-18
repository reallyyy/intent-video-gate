import { mkdir, readFile, writeFile } from "node:fs/promises";
import { paths, useProjectLocalPaths } from "./paths.js";

export const defaultConfig = {
  port: 47231,
  gemini: {
    command: "gemini",
    model: "gemini-3.1-flash-lite-preview",
    fallbackModel: "gemini-3-flash-preview",
    timeoutMs: 70000,
    retries: 2
  },
  tools: {
    ytdlp: "yt-dlp",
    mpv: "mpv",
    brave: "brave"
  },
  viewer: {
    mode: "native-browser",
    browser: "brave",
    grantTtlMs: 5 * 60 * 1000
  },
  suggestions: {
    mode: "ai-filtered-shelf",
    maxCollected: 80,
    feedSize: 20,
    youtubeCookieBrowser: "chromium:/home/camel/snap/chromium/common/chromium",
    youtubeRecommendationUrl: "https://www.youtube.com/feed/recommended"
  },
  policy: {
    blockShorts: true,
    maxDefaultDurationSeconds: 7200
  }
};

export async function ensureDirs() {
  try {
    await mkdir(paths.configDir, { recursive: true });
    await mkdir(paths.dataDir, { recursive: true });
  } catch (error) {
    if (process.env.INTENT_VIDEO_CONFIG_DIR || process.env.INTENT_VIDEO_DATA_DIR) throw error;
    useProjectLocalPaths();
    await mkdir(paths.configDir, { recursive: true });
    await mkdir(paths.dataDir, { recursive: true });
  }
}

export async function loadConfig() {
  await ensureDirs();
  try {
    const raw = await readFile(paths.configFile, "utf8");
    const parsed = JSON.parse(raw);
    return mergeConfig(defaultConfig, parsed);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await writeFile(paths.configFile, JSON.stringify(defaultConfig, null, 2) + "\n");
    return defaultConfig;
  }
}

function mergeConfig(base, override) {
  const out = { ...base, ...override };
  out.gemini = { ...base.gemini, ...(override.gemini || {}) };
  out.tools = { ...base.tools, ...(override.tools || {}) };
  out.viewer = { ...base.viewer, ...(override.viewer || {}) };
  out.suggestions = { ...base.suggestions, ...(override.suggestions || {}) };
  out.policy = { ...base.policy, ...(override.policy || {}) };
  return out;
}
