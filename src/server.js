import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyCandidates, refineFilterForVideo } from "./gemini.js";
import { proxyBilibiliThumbnail, thumbnailProxyPath } from "./bilibili.js";
import { createGrant, hasGrant } from "./grants.js";
import { commandExists } from "./process.js";
import { classifyBrowserNavigation, parseVideoUrl } from "./rules.js";
import { appendHistory, readAuthState, readBlockKeywords, readCachedFeed, readCachedSuggestions, readFilter, writeAuthState, writeCachedFeed, writeCachedSuggestions, writeFilter } from "./store.js";
import { metadataForUrl, youtubeRecommendations } from "./video.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const publicDir = join(root, "public");

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

export function createApp(config) {
  const feedItems = new Map();

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);

      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,OPTIONS",
          "access-control-allow-headers": "content-type"
        });
        return res.end();
      }

      if (req.method === "GET" && url.pathname === "/api/health") {
        return json(res, { ok: true, filter: await readFilter(), blockKeywords: await readBlockKeywords(config.blockKeywords), auth: await readAuthState(), doctor: await doctor(config) });
      }
      if (req.method === "POST" && url.pathname === "/api/session") {
        const body = await readJson(req);
        return json(res, { ok: true, auth: await writeAuthState(body.platform, body.status) });
      }
      if (req.method === "GET" && url.pathname === "/api/filter") {
        return json(res, { filter: await readFilter(), blockKeywords: await readBlockKeywords(config.blockKeywords) });
      }
      if (req.method === "POST" && url.pathname === "/api/filter") {
        const body = await readJson(req);
        await writeFilter(String(body.filter || "").trim(), Array.isArray(body.blockKeywords) ? body.blockKeywords : undefined);
        await writeCachedFeed([]);
        return json(res, { filter: await readFilter(), blockKeywords: await readBlockKeywords(config.blockKeywords) });
      }
      if (req.method === "POST" && url.pathname === "/api/filter/refine-video") {
        const body = await readJson(req);
        const item = await feedItemById(feedItems, String(body.id || ""));
        if (!item) return json(res, { error: "Unknown video." }, 404);
        const video = await detailedVideo(item, config);
        const result = await refineFilterForVideo({
          intent: await readFilter(),
          video,
          messages: body.messages,
          config
        });
        return json(res, {
          reply: result.reply,
          videoSummary: result.videoSummary,
          suggestedReasons: result.suggestedReasons,
          suggestedOptions: result.suggestedOptions,
          proposedFilter: result.proposedFilter
        });
      }
      if (req.method === "GET" && url.pathname === "/api/feed") {
        const refresh = url.searchParams.get("refresh") === "1";
        const cached = refresh ? [] : await readCachedFeed();
        const result = cached.length
          ? { items: cached, diagnostics: cachedFeedDiagnostics(cached) }
          : await approvedFeedResult(config);
        const items = result.items.map(publicCachedVideo);
        feedItems.clear();
        for (const item of items) feedItems.set(item.id, item);
        return json(res, { items, diagnostics: result.diagnostics });
      }
      if (req.method === "POST" && url.pathname === "/api/watch") {
        const body = await readJson(req);
        const item = feedItems.get(String(body.id));
        if (!item) return json(res, { error: "Unknown video." }, 404);
        const grant = createGrant(item.url, config.viewer.grantTtlMs);
        await appendHistory({ type: "watch", candidate: item });
        const parsed = parseVideoUrl(item.url);
        if (parsed?.platform === "bilibili" || parsed?.platform === "youtube") {
          return json(res, {
            mode: "native",
            grant,
            openUrl: item.url
          });
        }
        return json(res, { mode: "embed", grant, openUrl: item.url, embedUrl: embedUrlFor(item.url) });
      }
      if (req.method === "GET" && url.pathname === "/api/bilibili/thumbnail") {
        if (await proxyBilibiliThumbnail(url.searchParams.get("url") || "", res)) return;
        return text(res, "not found", 404);
      }
      if (req.method === "POST" && url.pathname === "/api/collect-bilibili") {
        const body = await readJson(req);
        const incoming = Array.isArray(body.items) ? body.items : [];
        const existing = (await readCachedSuggestions()).filter(isCollectedBilibiliItem);
        const normalized = normalizeCollected(incoming, "bilibili", config.suggestions.maxCollected);
        const merged = mergeByUrl([...normalized, ...existing]).slice(0, config.suggestions.maxCollected);
        await writeCachedSuggestions(merged);
        return json(res, { ok: true, count: merged.length });
      }
      if (req.method === "GET" && url.pathname === "/api/navigation") {
        return json(res, navigationDecision(url.searchParams.get("url") || ""));
      }
      if (req.method === "GET" && url.pathname === "/api/doctor") {
        return json(res, await doctor(config));
      }

      return serveStatic(req, res, url.pathname);
    } catch (error) {
      return json(res, { error: error.message || String(error) }, 500);
    }
  });
}

export async function doctor(config) {
  const checks = await Promise.all([
    tool("gemini", config.gemini.command, true),
    tool("yt-dlp", config.tools.ytdlp, true)
  ]);
  return { ok: checks.every((check) => check.ok), checks };
}

export async function approvedFeed(config) {
  return (await approvedFeedResult(config)).items;
}

export async function approvedFeedResult(config) {
  const filter = await readFilter();
  if (!filter) return { items: [], diagnostics: emptyDiagnostics() };

  const [youtube, cached] = await Promise.allSettled([
    youtubeRecommendations(config, config.suggestions.maxCollected),
    readCachedSuggestions()
  ]);
  const cachedBilibili = cached.status === "fulfilled" ? cached.value.filter(isCollectedBilibiliItem) : [];
  const candidates = selectFeedCandidates({
    cachedBilibili,
    youtubeItems: youtube.status === "fulfilled" ? youtube.value : [],
    limit: config.suggestions.maxCollected
  });

  const blockKeywords = await readBlockKeywords(config.blockKeywords);
  const prefiltered = applyKeywordPrefilter(candidates, blockKeywords);
  const gated = await classifyInBatches({ intent: filter, candidates: prefiltered.allowed, config, batchSize: 24 });
  const approved = gated.filter((item) => item.gate?.decision === "allow");
  const hydrated = await hydrateMissingThumbnails(mixedPlatforms(approved, config.suggestions.feedSize), config);
  const feed = hydrated.map(publicVideo);
  const diagnostics = buildFeedDiagnostics({ candidates, keywordBlocked: prefiltered.blocked, gated, approved: hydrated });
  await writeCachedFeed(feed);
  return { items: feed, diagnostics };
}

async function hydrateMissingThumbnails(items, config) {
  return Promise.all(items.map(async (item) => {
    if (item.thumbnail) return item;
    try {
      const metadata = await metadataForUrl(item.url, config);
      return { ...item, thumbnail: metadata.thumbnail || item.thumbnail, durationSeconds: item.durationSeconds || metadata.durationSeconds };
    } catch {
      return item;
    }
  }));
}

async function feedItemById(feedItems, id) {
  if (feedItems.has(id)) return feedItems.get(id);
  const cached = await readCachedFeed();
  return cached.find((item) => String(item.id) === id) || null;
}

async function detailedVideo(item, config) {
  try {
    const metadata = await metadataForUrl(item.url, config);
    return { ...item, ...metadata, id: item.id, title: item.title || metadata.title };
  } catch {
    return item;
  }
}

async function classifyInBatches({ intent, candidates, config, batchSize }) {
  const batches = [];
  for (let i = 0; i < candidates.length; i += batchSize) {
    batches.push(candidates.slice(i, i + batchSize));
  }
  const results = [];
  for (const batch of batches) {
    results.push(...await classifyCandidates({ intent, candidates: batch, config }));
  }
  return results;
}

function publicVideo(item) {
  return {
    id: item.id,
    platform: item.platform,
    title: item.gate?.safeTitle || item.title,
    uploader: item.uploader,
    durationSeconds: item.durationSeconds,
    thumbnail: item.platform === "bilibili" ? thumbnailProxyPath(item.thumbnail) || item.thumbnail : item.thumbnail,
    url: item.url
  };
}

function publicCachedVideo(item) {
  return {
    ...item,
    thumbnail: item.platform === "bilibili" ? thumbnailProxyPath(item.thumbnail) || item.thumbnail : item.thumbnail
  };
}

function embedUrlFor(rawUrl) {
  const parsed = parseVideoUrl(rawUrl);
  if (!parsed) return rawUrl;
  if (parsed.platform === "youtube") {
    return `https://www.youtube.com/embed/${encodeURIComponent(parsed.id)}?autoplay=1&rel=0`;
  }
  if (parsed.platform === "bilibili") {
    return `https://player.bilibili.com/player.html?bvid=${encodeURIComponent(parsed.id)}&autoplay=1`;
  }
  return rawUrl;
}

function normalizeCollected(items, platform, limit) {
  return items.slice(0, limit).map((item, index) => ({
    id: `${platform}:${item.id || Date.now()}:${index}`,
    platform,
    title: cleanTitle(String(item.title || "").trim(), platform),
    uploader: String(item.uploader || "").trim(),
    durationSeconds: Number(item.durationSeconds || 0),
    description: "",
    thumbnail: String(item.thumbnail || ""),
    url: String(item.url || "")
  })).filter((item) => item.title && item.url && (platform !== "bilibili" || isBilibiliVideoUrl(item.url)));
}

function cleanTitle(title, platform) {
  if (platform !== "bilibili") return title;
  return title
    .replace(/添加至稍后再看/g, "")
    .replace(/\d+(\.\d+)?万?/g, "")
    .replace(/\d{1,2}:\d{2}(:\d{2})?/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isBilibiliVideoUrl(rawUrl) {
  try {
    return /\/video\/BV/i.test(new URL(rawUrl).pathname);
  } catch {
    return false;
  }
}

function isCollectedBilibiliItem(item) {
  return item?.platform === "bilibili" && String(item.id || "").startsWith("bilibili:") && isBilibiliVideoUrl(item.url || "");
}

export function selectFeedCandidates({ cachedBilibili = [], youtubeItems = [], limit }) {
  return mixedPlatforms(mergeByUrl([...cachedBilibili, ...youtubeItems]), limit);
}

export function applyKeywordPrefilter(candidates = [], blockKeywords = []) {
  const keywords = normalizeKeywords(blockKeywords);
  if (!keywords.length) return { allowed: candidates, blocked: [] };

  const allowed = [];
  const blocked = [];
  for (const candidate of candidates) {
    const haystack = searchableText(candidate);
    const keyword = keywords.find((value) => haystack.includes(normalizeText(value)));
    if (!keyword) {
      allowed.push(candidate);
      continue;
    }
    blocked.push({
      ...candidate,
      gate: {
        decision: "block",
        confidence: 1,
        reason: `Blocked by keyword: ${keyword}`,
        labels: ["keyword-block"],
        safeTitle: candidate.title || "Blocked item",
        keyword
      }
    });
  }
  return { allowed, blocked };
}

function normalizeKeywords(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean))];
}

function searchableText(item) {
  return normalizeText([
    item.title,
    item.uploader,
    item.channel,
    ...(Array.isArray(item.tags) ? item.tags : [])
  ].filter(Boolean).join(" "));
}

function normalizeText(value) {
  return String(value || "").toLocaleLowerCase().normalize("NFKC");
}

function buildFeedDiagnostics({ candidates = [], keywordBlocked = [], gated = [], approved = [] }) {
  return {
    candidatesByPlatform: countBy(candidates, (item) => item.platform),
    keywordBlockedByPlatform: countBy(keywordBlocked, (item) => item.platform),
    decisions: countBy(gated, (item) => item.gate?.decision || "missing"),
    approvedByPlatform: countBy(approved, (item) => item.platform),
    keywordMatches: countBy(keywordBlocked, (item) => item.gate?.keyword || "unknown")
  };
}

function cachedFeedDiagnostics(items = []) {
  return {
    ...emptyDiagnostics(),
    approvedByPlatform: countBy(items, (item) => item.platform),
    cached: true
  };
}

function emptyDiagnostics() {
  return {
    candidatesByPlatform: {},
    keywordBlockedByPlatform: {},
    decisions: {},
    approvedByPlatform: {},
    keywordMatches: {}
  };
}

function countBy(items, getKey) {
  const counts = {};
  for (const item of items) {
    const key = String(getKey(item) || "unknown");
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function mergeByUrl(items) {
  const byUrl = new Map();
  for (const item of items) {
    if (item.url && !byUrl.has(item.url)) byUrl.set(item.url, item);
  }
  return [...byUrl.values()];
}

function mixedPlatforms(items, limit) {
  const byPlatform = new Map();
  for (const item of items) {
    const list = byPlatform.get(item.platform) || [];
    list.push(item);
    byPlatform.set(item.platform, list);
  }
  const platforms = [...byPlatform.keys()];
  const mixed = [];
  while (mixed.length < limit && platforms.some((platform) => byPlatform.get(platform)?.length)) {
    for (const platform of platforms) {
      const item = byPlatform.get(platform)?.shift();
      if (item) mixed.push(item);
      if (mixed.length >= limit) break;
    }
  }
  return mixed;
}

function navigationDecision(rawUrl) {
  if (hasGrant(rawUrl)) return { action: "allow" };
  return classifyBrowserNavigation(rawUrl);
}

async function tool(name, command, required) {
  return { name, command, required, ok: await commandExists(command) };
}

async function serveStatic(req, res, pathname) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = resolve(join(publicDir, safePath));
  if (!filePath.startsWith(publicDir)) return text(res, "not found", 404);
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { "content-type": mime[extname(filePath)] || "application/octet-stream" });
    res.end(data);
  } catch {
    text(res, "not found", 404);
  }
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function json(res, payload, status = 200) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type"
  });
  res.end(JSON.stringify(payload));
}

function text(res, payload, status = 200) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(payload);
}
