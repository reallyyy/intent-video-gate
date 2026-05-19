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
  const args = [`${prefix}${limit}:${query}`, "--dump-json", "--skip-download", "--flat-playlist"];
  if (platform === "bilibili" && config.suggestions.bilibiliCookieBrowser) args.unshift("--cookies-from-browser", config.suggestions.bilibiliCookieBrowser);
  if (platform === "youtube" && config.suggestions.youtubeCookieBrowser) args.unshift("--cookies-from-browser", config.suggestions.youtubeCookieBrowser);
  const result = await run(config.tools.ytdlp, args, {
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

export async function bilibiliSearchApi(query, limit = 8) {
  const url = new URL("https://api.bilibili.com/x/web-interface/search/type");
  url.searchParams.set("search_type", "video");
  url.searchParams.set("keyword", query);
  url.searchParams.set("page", "1");
  url.searchParams.set("page_size", String(limit));
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      referer: "https://www.bilibili.com/",
      "user-agent": "Mozilla/5.0"
    }
  });
  if (!response.ok) throw new Error(`Bilibili search API failed: HTTP ${response.status}`);
  const payload = await response.json();
  if (payload?.code !== 0 || !Array.isArray(payload?.data?.result)) {
    throw new Error(payload?.message || "Bilibili search API returned no results");
  }
  return payload.data.result
    .filter((item) => item?.type === "video" && item?.bvid)
    .map((item) => normalizeBilibiliSearchApiItem(item))
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

export async function bilibiliApiRecommendations(limit = 24) {
  const url = new URL("https://api.bilibili.com/x/web-interface/index/top/feed/rcmd");
  url.searchParams.set("ps", String(limit));
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      referer: "https://www.bilibili.com/",
      "user-agent": "Mozilla/5.0"
    }
  });
  if (!response.ok) throw new Error(`Bilibili API failed: HTTP ${response.status}`);
  const payload = await response.json();
  if (payload?.code !== 0 || !Array.isArray(payload?.data?.item)) {
    throw new Error(payload?.message || "Bilibili API returned no recommendations");
  }
  return payload.data.item
    .filter((item) => item?.bvid && item?.goto === "av")
    .map((item) => normalizeBilibiliApiItem(item))
    .slice(0, limit);
}

export async function bilibiliSubtitleTracksForUrl(rawUrl) {
  const parsed = parseVideoUrl(rawUrl);
  if (parsed?.platform !== "bilibili") throw new Error("Unsupported Bilibili URL.");
  const view = await fetchBilibiliJson(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(parsed.id)}`);
  if (view?.code !== 0) throw new Error(view?.message || "Bilibili video metadata unavailable");

  const tracks = [];
  addSubtitleTracks(tracks, view?.data?.subtitle?.list, "view");
  const cid = view?.data?.cid || view?.data?.pages?.[0]?.cid;
  if (cid) {
    try {
      const player = await fetchBilibiliJson(`https://api.bilibili.com/x/player/v2?cid=${encodeURIComponent(cid)}&bvid=${encodeURIComponent(parsed.id)}`);
      addSubtitleTracks(tracks, player?.data?.subtitle?.subtitles || player?.data?.subtitle?.list, "player");
    } catch {
      // The view endpoint is the primary source; player subtitle metadata is best effort.
    }
  }
  return uniqueSubtitleTracks(tracks);
}

export function englishCapableBilibiliSubtitleTracks(tracks = []) {
  return tracks.filter(isEnglishCapableSubtitleTrack);
}

export function isEnglishCapableSubtitleTrack(track) {
  const language = normalizeSubtitleText(track?.language);
  const label = normalizeSubtitleText(track?.label);
  const haystack = `${language} ${label}`;
  return /\ben(-|_|$|\b)/.test(language) ||
    /\beng(lish)?\b/.test(haystack) ||
    /english|英文|英语|中英|英中|双语|雙語|bilingual/.test(haystack);
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

async function fetchBilibiliJson(url) {
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      referer: "https://www.bilibili.com/",
      "user-agent": "Mozilla/5.0"
    }
  });
  if (!response.ok) throw new Error(`Bilibili metadata failed: HTTP ${response.status}`);
  return await response.json();
}

function addSubtitleTracks(output, tracks, source) {
  if (!Array.isArray(tracks)) return;
  for (const track of tracks) {
    const language = String(track?.lan || track?.language || "").trim();
    const label = String(track?.lan_doc || track?.label || track?.name || language || "subtitle").trim();
    const url = normalizeProtocolUrl(track?.subtitle_url || track?.url || "");
    if (!language && !label && !url) continue;
    output.push({ language, label, url, source });
  }
}

function uniqueSubtitleTracks(tracks) {
  const seen = new Set();
  const out = [];
  for (const track of tracks) {
    const key = `${track.language}:${track.label}:${track.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(track);
  }
  return out;
}

function normalizeSubtitleText(value) {
  return String(value || "").trim().toLocaleLowerCase().normalize("NFKC");
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

function normalizeBilibiliApiItem(item) {
  return {
    id: `bilibili:${item.bvid}`,
    platform: "bilibili",
    videoId: item.bvid,
    title: item.title || "(untitled)",
    uploader: item.owner?.name || "",
    channel: item.owner?.name || "",
    durationSeconds: Number(item.duration || 0),
    description: "",
    categories: [],
    tags: [],
    viewCount: Number(item.stat?.view || 0),
    uploadDate: "",
    thumbnail: item.pic || "",
    url: `https://www.bilibili.com/video/${item.bvid}`
  };
}

function normalizeBilibiliSearchApiItem(item) {
  const bvid = item.bvid;
  return {
    id: `bilibili:${bvid}`,
    platform: "bilibili",
    videoId: bvid,
    title: cleanHtml(item.title || "(untitled)"),
    uploader: item.author || "",
    channel: item.author || "",
    durationSeconds: parseDuration(item.duration),
    description: cleanHtml(item.description || ""),
    categories: item.typename ? [item.typename] : [],
    tags: item.tag ? String(item.tag).split(",").map((tag) => tag.trim()).filter(Boolean) : [],
    viewCount: Number(item.play || 0),
    uploadDate: item.pubdate ? new Date(Number(item.pubdate) * 1000).toISOString().slice(0, 10).replace(/-/g, "") : "",
    thumbnail: normalizeProtocolUrl(item.pic || ""),
    url: `https://www.bilibili.com/video/${bvid}`
  };
}

function cleanHtml(value) {
  return String(value || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function normalizeProtocolUrl(value) {
  const text = String(value || "");
  if (text.startsWith("//")) return `https:${text}`;
  return text;
}

function parseDuration(value) {
  const parts = String(value || "").split(":").map((part) => Number(part));
  if (parts.some((part) => !Number.isFinite(part))) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return Number(value || 0) || 0;
}
