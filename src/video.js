import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { commandExists, run } from "./process.js";
import { parseVideoUrl } from "./rules.js";

export async function metadataForUrl(url, config) {
  const parsed = parseVideoUrl(url);
  if (!parsed) throw new Error("Unsupported URL. Paste a YouTube or Bilibili video URL.");
  const result = await run(config.tools.ytdlp, ["--dump-json", "--no-playlist", parsed.canonicalUrl], {
    timeoutMs: 45000,
    maxBuffer: 12 * 1024 * 1024
  });
  if (!result.ok) throw new Error(result.stderr || result.error || "yt-dlp failed");
  return normalizeYtdlpJson(result.stdout, parsed.platform, parsed.canonicalUrl);
}

export async function searchVideos(platform, query, limit, config) {
  const prefix = platform === "bilibili" ? "bilisearch" : "ytsearch";
  const result = await run(config.tools.ytdlp, [`${prefix}${limit}:${query}`, "--dump-json", "--skip-download", "--flat-playlist"], {
    timeoutMs: 60000,
    maxBuffer: 16 * 1024 * 1024
  });
  if (!result.ok) throw new Error(result.stderr || result.error || "yt-dlp search failed");
  return result.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => normalizeYtdlpJson(line, platform))
    .slice(0, limit);
}

export async function youtubeRecommendations(config, limit = 24) {
  const args = [
    "--flat-playlist",
    "--dump-json",
    "--playlist-end",
    String(limit),
    config.suggestions.youtubeRecommendationUrl
  ];
  if (config.suggestions.youtubeCookieBrowser) args.unshift("--cookies-from-browser", config.suggestions.youtubeCookieBrowser);
  const result = await run(config.tools.ytdlp, args, {
    timeoutMs: 70000,
    maxBuffer: 24 * 1024 * 1024
  });
  if (!result.ok) throw new Error(result.stderr || result.error || "yt-dlp recommendation extraction failed");
  return result.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => normalizeYtdlpJson(line, "youtube"))
    .filter((item) => item.url.includes("youtube.com/watch"))
    .slice(0, limit);
}

export async function bilibiliRecommendations(config, limit = 24) {
  const args = [
    "--flat-playlist",
    "--dump-json",
    "--playlist-end",
    String(limit),
    config.suggestions.bilibiliRecommendationUrl
  ];
  if (config.suggestions.bilibiliCookieBrowser) args.unshift("--cookies-from-browser", config.suggestions.bilibiliCookieBrowser);
  const result = await run(config.tools.ytdlp, args, {
    timeoutMs: 70000,
    maxBuffer: 24 * 1024 * 1024
  });
  if (!result.ok) throw new Error(result.stderr || result.error || "yt-dlp Bilibili recommendation extraction failed");
  return result.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => normalizeYtdlpJson(line, "bilibili"))
    .filter((item) => item.url.includes("bilibili.com/video/"))
    .slice(0, limit);
}

export async function playVideo(url, config) {
  if (!(await commandExists(config.tools.mpv))) {
    throw new Error(`mpv not found at command: ${config.tools.mpv}`);
  }
  const child = spawn(config.tools.mpv, ["--force-window=yes", url], {
    detached: true,
    stdio: "ignore"
  });
  child.on("error", () => {});
  child.unref();
  return { started: true };
}

export function normalizeYtdlpJson(raw, fallbackPlatform, fallbackUrl) {
  const item = typeof raw === "string" ? JSON.parse(raw) : raw;
  const url = item.webpage_url || item.original_url || item.url || fallbackUrl;
  const parsed = url ? parseVideoUrl(url) : null;
  return {
    id: `${fallbackPlatform || parsed?.platform || "video"}:${item.id || randomUUID()}`,
    platform: parsed?.platform || fallbackPlatform || item.extractor_key?.toLowerCase() || "unknown",
    videoId: item.id || parsed?.id || "",
    title: item.title || "(untitled)",
    uploader: item.uploader || item.channel || item.creator || "",
    channel: item.channel || item.uploader || item.creator || "",
    durationSeconds: Number(item.duration || 0),
    description: item.description || "",
    categories: Array.isArray(item.categories) ? item.categories : [],
    tags: Array.isArray(item.tags) ? item.tags : [],
    viewCount: Number(item.view_count || 0),
    uploadDate: item.upload_date || "",
    thumbnail: bestThumbnail(item),
    url: parsed?.canonicalUrl || item.webpage_url || fallbackUrl || item.url || ""
  };
}

function bestThumbnail(item) {
  if (item.thumbnail) return item.thumbnail;
  if (Array.isArray(item.thumbnails) && item.thumbnails.length) {
    return [...item.thumbnails]
      .filter((thumbnail) => thumbnail?.url)
      .sort((a, b) => Number(b.width || 0) - Number(a.width || 0))[0]?.url || "";
  }
  return "";
}
