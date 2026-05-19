import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultConfig } from "./config.js";
import { classifyCandidates, generateBilibiliSearchQueries, refineFilterForVideo } from "./gemini.js";
import { proxyBilibiliThumbnail, thumbnailProxyPath } from "./bilibili.js";
import { createGrant, hasGrant } from "./grants.js";
import { commandExists } from "./process.js";
import { classifyBrowserNavigation, parseVideoUrl } from "./rules.js";
import { FEED_POLICY_VERSION, appendHistory, readAuthState, readBlockKeywords, readCachedFeed, readCachedFeedPolicy, readCachedSuggestions, readFilter, writeAuthState, writeBlockKeywords, writeCachedFeed, writeCachedSuggestions, writeFilter } from "./store.js";
import { bilibiliApiRecommendations, bilibiliRecommendations, bilibiliSearchApi, bilibiliSubtitleTracksForUrl, englishCapableBilibiliSubtitleTracks, metadataForUrl, searchVideos, youtubeRecommendations } from "./video.js";

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
        return json(res, { ok: true, filter: await readFilter(), blockKeywords: await readBlockKeywords(config.blockKeywords), defaultBlockKeywords: defaultConfig.blockKeywords, auth: await readAuthState(), doctor: await doctor(config) });
      }
      if (req.method === "POST" && url.pathname === "/api/session") {
        const body = await readJson(req);
        return json(res, { ok: true, auth: await writeAuthState(body.platform, body.status) });
      }
      if (req.method === "GET" && url.pathname === "/api/block-keywords") {
        return json(res, { blockKeywords: await readBlockKeywords(config.blockKeywords), defaultBlockKeywords: defaultConfig.blockKeywords });
      }
      if (req.method === "PUT" && url.pathname === "/api/block-keywords") {
        const body = await readJson(req);
        if (!Array.isArray(body.blockKeywords)) return json(res, { error: "blockKeywords must be an array." }, 400);
        await writeCachedFeed([]);
        return json(res, { blockKeywords: await writeBlockKeywords(body.blockKeywords), defaultBlockKeywords: defaultConfig.blockKeywords });
      }
      if (req.method === "GET" && url.pathname === "/api/filter") {
        return json(res, { filter: await readFilter(), blockKeywords: await readBlockKeywords(config.blockKeywords), defaultBlockKeywords: defaultConfig.blockKeywords });
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
        const cachedPolicy = refresh || !cached.length ? FEED_POLICY_VERSION : await readCachedFeedPolicy();
        const staleCachedFeed = cached.length > 0 && cachedPolicy !== FEED_POLICY_VERSION;
        if (staleCachedFeed) await writeCachedFeed([]);
        const cachedSuggestions = refresh ? [] : await readCachedSuggestions();
        const useCached = cached.length && !staleCachedFeed && !cachedFeedNeedsRefresh(cached, cachedSuggestions, config.suggestions.feedSize);
        const result = useCached
          ? { items: cached, diagnostics: cachedFeedDiagnostics(cached) }
          : await approvedFeedResult(config, { refresh });
        if (staleCachedFeed) {
          result.diagnostics.warnings.unshift("Cached feed was rebuilt because the Bilibili subtitle policy changed.");
        }
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
        const existing = normalizeBilibiliItems((await readCachedSuggestions()).filter(isCollectedBilibiliItem));
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

export async function approvedFeedResult(config, options = {}) {
  const filter = await readFilter();
  if (!filter) return { items: [], diagnostics: emptyDiagnostics() };

  const refresh = Boolean(options.refresh);
  const cachedBilibili = normalizeBilibiliItems((await readCachedSuggestions()).filter(isCollectedBilibiliItem));
  const [youtube, bilibili] = await Promise.allSettled([
    youtubeRecommendations(config, config.suggestions.maxCollected),
    refresh ? refreshedBilibiliRecommendations(config, cachedBilibili) : Promise.resolve({
      items: cachedBilibili,
      status: { ok: true, count: cachedBilibili.length, source: "cache" },
      cacheItems: cachedBilibili
    })
  ]);
  const bilibiliResult = bilibili.status === "fulfilled"
    ? bilibili.value
    : {
      items: cachedBilibili,
      status: { ok: false, error: bilibili.reason?.message || String(bilibili.reason || "source failed"), count: cachedBilibili.length, fallback: "cache" },
      cacheItems: cachedBilibili
    };
  const bilibiliItems = bilibiliResult.items;
  const candidates = selectFeedCandidates({
    cachedBilibili: bilibiliItems,
    youtubeItems: youtube.status === "fulfilled" ? youtube.value : [],
    limit: config.suggestions.maxCollected
  });

  const blockKeywords = await readBlockKeywords(config.blockKeywords);
  const subtitleFiltered = await applyBilibiliSubtitlePrefilter(candidates);
  const prefiltered = applyKeywordPrefilter(subtitleFiltered.allowed, blockKeywords);
  const gated = await classifyInBatches({ intent: filter, candidates: prefiltered.allowed, config, batchSize: 24 });
  const search = await searchApprovedBilibiliIfNeeded({
    intent: filter,
    blockKeywords,
    initialCandidates: candidates,
    keywordAllowed: prefiltered.allowed,
    keywordBlocked: [...subtitleFiltered.blocked, ...prefiltered.blocked],
    gated,
    config
  });
  const allSubtitleBlocked = [...subtitleFiltered.blocked, ...search.subtitleBlocked];
  const allKeywordBlocked = [...prefiltered.blocked, ...search.keywordBlocked];
  const allGated = [...gated, ...search.gated];
  const approved = allGated.filter((item) => item.gate?.decision === "allow");
  const selection = selectFinalFeed(approved, config.suggestions.feedSize);
  const hydrated = await hydrateMissingThumbnails(selection.items, config);
  const feed = hydrated.map(publicVideo);
  const diagnostics = buildFeedDiagnostics({
    candidates,
    subtitleBlocked: allSubtitleBlocked,
    keywordBlocked: allKeywordBlocked,
    gated: allGated,
    approvedPool: approved,
    feed: hydrated,
    selection,
    search,
    sources: {
      refresh,
      youtube: settledSourceStatus(youtube),
      bilibili: bilibili.status === "fulfilled" ? bilibiliResult.status : settledSourceStatus(bilibili)
    }
  });
  if (refresh && bilibili.status === "fulfilled" && bilibiliResult.cacheItems.length) await writeCachedSuggestions(bilibiliResult.cacheItems);
  await writeCachedFeed(feed);
  return { items: feed, diagnostics };
}

async function searchApprovedBilibiliIfNeeded({ intent, blockKeywords, initialCandidates, keywordAllowed, keywordBlocked, gated, config }) {
  const target = feedTargets(config.suggestions.feedSize).bilibili;
  const approvedBilibili = gated.filter((item) => item.platform === "bilibili" && item.gate?.decision === "allow").length;
  const empty = {
    queries: [],
    candidatesByQuery: {},
    candidates: [],
    subtitleBlocked: [],
    keywordBlocked: [],
    gated: [],
    approved: 0,
    errors: []
  };
  if (approvedBilibili >= target) return empty;

  const rejectedBilibili = [
    ...keywordBlocked.filter((item) => item.platform === "bilibili"),
    ...gated.filter((item) => item.platform === "bilibili" && item.gate?.decision !== "allow")
  ];
  const approved = gated.filter((item) => item.gate?.decision === "allow");
  const queries = await generateBilibiliSearchQueries({
    intent,
    blockKeywords,
    approved,
    rejectedBilibili,
    config
  });
  if (!queries.length) return { ...empty, errors: ["Gemini did not return Bilibili search queries."] };

  const seenUrls = new Set(initialCandidates.map((item) => item.url).filter(Boolean));
  const candidatesByQuery = {};
  const searchCandidates = [];
  const errors = [];
  for (const query of queries) {
    try {
      const results = (await searchBilibiliVideos(query, 8, config))
        .filter((item) => item.url && !seenUrls.has(item.url));
      candidatesByQuery[query] = results.length;
      for (const item of results) {
        seenUrls.add(item.url);
        searchCandidates.push(item);
      }
    } catch (error) {
      candidatesByQuery[query] = 0;
      errors.push(`${query}: ${error.message || String(error)}`);
    }
  }

  const subtitleFiltered = await applyBilibiliSubtitlePrefilter(searchCandidates);
  const prefiltered = applyKeywordPrefilter(subtitleFiltered.allowed, blockKeywords);
  const searchedGated = await classifyInBatches({ intent, candidates: prefiltered.allowed, config, batchSize: 24 });
  return {
    queries,
    candidatesByQuery,
    candidates: searchCandidates,
    subtitleBlocked: subtitleFiltered.blocked,
    keywordBlocked: prefiltered.blocked,
    gated: searchedGated,
    approved: searchedGated.filter((item) => item.platform === "bilibili" && item.gate?.decision === "allow").length,
    errors
  };
}

export async function applyBilibiliSubtitlePrefilter(candidates = []) {
  const allowed = [];
  const blocked = [];
  for (const candidate of candidates) {
    if (candidate.platform !== "bilibili") {
      allowed.push(candidate);
      continue;
    }
    try {
      const subtitleTracks = await bilibiliSubtitleTracksForUrl(candidate.url);
      const englishSubtitleTracks = englishCapableBilibiliSubtitleTracks(subtitleTracks);
      if (englishSubtitleTracks.length) {
        allowed.push({ ...candidate, subtitleTracks, englishSubtitleTracks, subtitleEligibility: "english-capable" });
        continue;
      }
      if (!subtitleTracks.length) {
        allowed.push({ ...candidate, subtitleTracks, englishSubtitleTracks, subtitleEligibility: "unverified" });
        continue;
      }
      blocked.push(blockBilibiliSubtitleCandidate(candidate, "Bilibili video has subtitles, but no English-capable subtitle track."));
    } catch (error) {
      blocked.push(blockBilibiliSubtitleCandidate(candidate, `Bilibili subtitle check failed: ${error.message || String(error)}`));
    }
  }
  return { allowed, blocked };
}

function blockBilibiliSubtitleCandidate(candidate, reason) {
  return {
    ...candidate,
    gate: {
      decision: "block",
      confidence: 1,
      reason,
      labels: ["bilibili-subtitle-required"],
      safeTitle: candidate.title || "Blocked Bilibili item"
    }
  };
}

async function searchBilibiliVideos(query, limit, config) {
  try {
    const ytdlpItems = normalizeBilibiliItems(await searchVideos("bilibili", query, limit, config));
    if (ytdlpItems.length) return ytdlpItems;
  } catch {
    // Fall through to the public Bilibili search API; yt-dlp search often fails with HTTP 412.
  }
  return normalizeBilibiliItems(await bilibiliSearchApi(query, limit));
}

async function refreshedBilibiliRecommendations(config, cachedBilibili) {
  const attempts = [];
  const limit = config.suggestions.maxCollected;
  try {
    const ytdlpItems = normalizeBilibiliItems(await bilibiliRecommendations(config, limit));
    if (ytdlpItems.length) {
      const merged = mergeByUrl([...ytdlpItems, ...cachedBilibili]).slice(0, limit);
      return {
        items: merged,
        cacheItems: merged,
        status: { ok: true, count: merged.length, source: "yt-dlp" }
      };
    }
    attempts.push({ source: "yt-dlp", error: "no Bilibili videos returned" });
  } catch (error) {
    attempts.push({ source: "yt-dlp", error: error.message || String(error) });
  }

  try {
    const apiItems = normalizeBilibiliItems(await bilibiliApiRecommendations(limit));
    if (apiItems.length) {
      const merged = mergeByUrl([...apiItems, ...cachedBilibili]).slice(0, limit);
      return {
        items: merged,
        cacheItems: merged,
        status: { ok: true, count: merged.length, source: "api", fallback: "api", attempts }
      };
    }
    attempts.push({ source: "api", error: "no Bilibili videos returned" });
  } catch (error) {
    attempts.push({ source: "api", error: error.message || String(error) });
  }

  return {
    items: cachedBilibili,
    cacheItems: cachedBilibili,
    status: {
      ok: cachedBilibili.length > 0,
      count: cachedBilibili.length,
      source: "cache",
      fallback: "cache",
      attempts,
      ...(cachedBilibili.length ? {} : { error: "Bilibili refresh failed and cache is empty" })
    }
  };
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
  return items.slice(0, limit).map((item, index) => {
    const parsed = parseVideoUrl(item.url || "");
    const canonicalUrl = parsed?.canonicalUrl || String(item.url || "");
    return {
      id: platform === "bilibili" && parsed?.id ? `bilibili:${parsed.id}` : `${platform}:${item.id || Date.now()}:${index}`,
      platform,
      title: cleanTitle(String(item.title || "").trim(), platform),
      uploader: String(item.uploader || "").trim(),
      durationSeconds: Number(item.durationSeconds || 0),
      description: "",
      thumbnail: String(item.thumbnail || ""),
      url: canonicalUrl
    };
  }).filter((item) => item.title && item.url && (platform !== "bilibili" || isBilibiliVideoUrl(item.url)));
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

function normalizeBilibiliItems(items = []) {
  return mergeByUrl(items.map((item) => {
    const parsed = parseVideoUrl(item.url || "");
    if (parsed?.platform !== "bilibili") return item;
    return {
      ...item,
      id: `bilibili:${parsed.id}`,
      platform: "bilibili",
      videoId: parsed.id,
      url: parsed.canonicalUrl
    };
  }).filter(isCollectedBilibiliItem));
}

export function selectFeedCandidates({ cachedBilibili = [], youtubeItems = [], limit }) {
  return mixedPlatforms(mergeByUrl([...cachedBilibili, ...youtubeItems]), limit);
}

export function selectFinalFeed(approved = [], feedSize = 20) {
  const targetByPlatform = feedTargets(feedSize);
  const byPlatform = {
    youtube: approved.filter((item) => item.platform === "youtube"),
    bilibili: approved.filter((item) => item.platform === "bilibili")
  };
  const selectedBilibili = byPlatform.bilibili.slice(0, targetByPlatform.bilibili);
  const selectedYoutube = byPlatform.youtube.slice(0, targetByPlatform.youtube);
  const totalTarget = targetByPlatform.youtube + targetByPlatform.bilibili;
  const items = placeBilibiliCards(selectedYoutube, selectedBilibili, totalTarget).slice(0, totalTarget);
  const warnings = [];
  if (byPlatform.bilibili.length < targetByPlatform.bilibili) {
    warnings.push(`Only ${byPlatform.bilibili.length} approved Bilibili video${byPlatform.bilibili.length === 1 ? "" : "s"} available; target is ${targetByPlatform.bilibili}.`);
  }
  return {
    items,
    targetByPlatform,
    approvedPoolByPlatform: countBy(approved, (item) => item.platform),
    feedByPlatform: countBy(items, (item) => item.platform),
    warnings
  };
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

function buildFeedDiagnostics({ candidates = [], subtitleBlocked = [], keywordBlocked = [], gated = [], approvedPool = [], feed = [], selection, search, sources }) {
  const sourceWarnings = [];
  if (sources?.bilibili?.fallback === "cache") {
    sourceWarnings.push("Bilibili refresh failed; using cached Bilibili recommendations.");
  } else if (sources?.bilibili?.fallback === "api") {
    sourceWarnings.push("Bilibili yt-dlp refresh failed; using Bilibili API recommendations.");
  }
  const searchWarnings = [];
  if (search?.queries?.length && !search.approved) {
    searchWarnings.push("Bilibili search ran but Gemini approved no Bilibili search results.");
  }
  return {
    candidatesByPlatform: countBy(candidates, (item) => item.platform),
    subtitleBlockedByPlatform: countBy(subtitleBlocked, (item) => item.platform),
    keywordBlockedByPlatform: countBy(keywordBlocked, (item) => item.platform),
    decisions: countBy(gated, (item) => item.gate?.decision || "missing"),
    approvedPoolByPlatform: selection?.approvedPoolByPlatform || countBy(approvedPool, (item) => item.platform),
    approvedByPlatform: selection?.feedByPlatform || countBy(feed, (item) => item.platform),
    feedByPlatform: selection?.feedByPlatform || countBy(feed, (item) => item.platform),
    targetByPlatform: selection?.targetByPlatform || feedTargets(defaultConfig.suggestions.feedSize),
    keywordMatches: countBy(keywordBlocked, (item) => item.gate?.keyword || "unknown"),
    bilibiliSearchQueries: search?.queries || [],
    bilibiliSearchCandidatesByQuery: search?.candidatesByQuery || {},
    bilibiliSearchApproved: Number(search?.approved || 0),
    bilibiliSearchErrors: search?.errors || [],
    bilibiliSubtitleChecks: {
      checked: candidates.filter((item) => item.platform === "bilibili").length + Number(search?.candidates?.length || 0),
      eligible: candidates.filter((item) => item.platform === "bilibili").length + Number(search?.candidates?.length || 0) - subtitleBlocked.length,
      blocked: subtitleBlocked.length
    },
    warnings: [...(selection?.warnings || []), ...sourceWarnings, ...searchWarnings],
    ...(sources ? { sources } : {})
  };
}

function cachedFeedDiagnostics(items = []) {
  return {
    ...emptyDiagnostics(),
    approvedByPlatform: countBy(items, (item) => item.platform),
    feedByPlatform: countBy(items, (item) => item.platform),
    cached: true
  };
}

function emptyDiagnostics() {
  return {
    candidatesByPlatform: {},
    subtitleBlockedByPlatform: {},
    keywordBlockedByPlatform: {},
    decisions: {},
    approvedByPlatform: {},
    approvedPoolByPlatform: {},
    feedByPlatform: {},
    targetByPlatform: feedTargets(defaultConfig.suggestions.feedSize),
    keywordMatches: {},
    bilibiliSearchQueries: [],
    bilibiliSearchCandidatesByQuery: {},
    bilibiliSearchApproved: 0,
    bilibiliSearchErrors: [],
    bilibiliSubtitleChecks: { checked: 0, eligible: 0, blocked: 0 },
    warnings: []
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

function settledSourceStatus(result) {
  if (result.status === "fulfilled") return { ok: true, count: Array.isArray(result.value) ? result.value.length : 0 };
  return { ok: false, error: result.reason?.message || String(result.reason || "source failed") };
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

function feedTargets(feedSize) {
  const size = Math.max(0, Number(feedSize) || 0);
  if (!size) return { youtube: 0, bilibili: 0 };
  const bilibili = Math.max(1, Math.round(size * 0.1));
  return { youtube: size, bilibili };
}

function cachedFeedNeedsRefresh(cachedFeed = [], cachedSuggestions = [], feedSize = 20) {
  const targets = feedTargets(feedSize);
  const feedCounts = countBy(cachedFeed, (item) => item.platform);
  const bilibiliSuggestionCount = cachedSuggestions.filter(isCollectedBilibiliItem).length;
  const expectedBilibili = Math.min(targets.bilibili, bilibiliSuggestionCount);
  return expectedBilibili > 0 && Number(feedCounts.bilibili || 0) < expectedBilibili;
}

function placeBilibiliCards(otherItems, bilibiliItems, feedSize) {
  const output = [...otherItems];
  const count = bilibiliItems.length;
  for (let i = 0; i < count; i += 1) {
    const position = count === 2
      ? Math.round(feedSize * (i === 0 ? 0.25 : 0.75))
      : Math.round(feedSize * ((i + 1) / (count + 1)));
    output.splice(Math.min(position, output.length), 0, bilibiliItems[i]);
  }
  return output;
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
