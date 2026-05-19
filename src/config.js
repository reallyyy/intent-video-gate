import { mkdir, readFile, writeFile } from "node:fs/promises";
import { commandExists } from "./process.js";
import { paths, useProjectLocalPaths } from "./paths.js";

const COOKIE_BROWSER_CANDIDATES = ["chromium", "brave", "google-chrome", "firefox"];

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
    youtubeCookieBrowser: "",
    youtubeRecommendationUrl: "https://www.youtube.com/feed/recommended",
    bilibiliCookieBrowser: "",
    bilibiliRecommendationUrl: "https://www.bilibili.com/v/popular/all"
  },
  blockKeywords: ["warhammer", "战锤", "星际道士", "道士", "sora", "B站AI创作大赛"],
  policy: {
    blockShorts: true,
    maxDefaultDurationSeconds: 7200
  }
};

export async function detectCookieBrowser() {
  for (const candidate of COOKIE_BROWSER_CANDIDATES) {
    if (await commandExists(candidate)) return candidate;
  }
  return "";
}

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
  let saved;
  try {
    const raw = await readFile(paths.configFile, "utf8");
    saved = JSON.parse(raw);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await writeFile(paths.configFile, JSON.stringify(defaultConfig, null, 2) + "\n");
    saved = {};
  }
  const config = mergeConfig(defaultConfig, saved);
  if (!config.suggestions.youtubeCookieBrowser) {
    config.suggestions.youtubeCookieBrowser = await detectCookieBrowser();
  }
  if (!config.suggestions.bilibiliCookieBrowser) {
    config.suggestions.bilibiliCookieBrowser = await detectCookieBrowser();
  }
  return config;
}

function mergeConfig(base, override) {
  const out = { ...base, ...override };
  out.gemini = { ...base.gemini, ...(override.gemini || {}) };
  out.tools = { ...base.tools, ...(override.tools || {}) };
  out.viewer = { ...base.viewer, ...(override.viewer || {}) };
  out.suggestions = { ...base.suggestions, ...(override.suggestions || {}) };
  out.blockKeywords = normalizeList(override.blockKeywords || base.blockKeywords);
  out.policy = { ...base.policy, ...(override.policy || {}) };
  return out;
}

function normalizeList(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean))];
}
