import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultConfig } from "./config.js";
import { classifyCandidates, generateBilibiliSearchQueries, refineFilterForVideo, translateSubtitleEntries } from "./gemini.js";
import { proxyBilibiliThumbnail, thumbnailProxyPath } from "./bilibili.js";
import { createGrant, hasGrant } from "./grants.js";
import { commandExists } from "./process.js";
import { classifyBrowserNavigation, parseVideoUrl } from "./rules.js";
import { FEED_POLICY_VERSION, appendHistory, getCachedTranslation, readAuthState, readBlockKeywords, readCachedFeed, readCachedFeedPolicy, readCachedSuggestions, readCachedTranslation, readFilter, writeAuthState, writeBlockKeywords, writeCachedFeed, writeCachedSuggestions, writeCachedTranslation, writeFilter } from "./store.js";
import { bilibiliApiRecommendations, bilibiliRecommendations, bilibiliSearchApi, bilibiliSubtitleTracksForUrl, chineseBilibiliSubtitleTracks, englishCapableBilibiliSubtitleTracks, fetchBilibiliSubtitleJson, metadataForUrl, searchVideos, youtubeRecommendations } from "./video.js";

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
  let bilibiliCookieHeader = "";
  let feedProgress = feedProgressState("idle", "Feed is idle.", false);

  globalThis.__intentBilibiliCookie = () => bilibiliCookieHeader;

  async function fetchJsonViaNode(url) {
    const headers = {
      accept: "application/json",
      referer: "https://www.bilibili.com/",
      "user-agent": "Mozilla/5.0"
    };
    if (bilibiliCookieHeader) headers.cookie = bilibiliCookieHeader;
    const response = await fetch(url, { headers });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  }

  const server = createServer(async (req, res) => {
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
      if (req.method === "GET" && url.pathname === "/api/feed-status") {
        return json(res, currentFeedProgress(feedProgress));
      }
      if (req.method === "POST" && url.pathname === "/api/session") {
        const body = await readJson(req);
        return json(res, { ok: true, auth: await writeAuthState(body.platform, body.status) });
      }
      if (req.method === "POST" && url.pathname === "/api/bilibili-cookies") {
        const body = await readJson(req);
        if (typeof body.cookie === "string" && body.cookie.length) {
          bilibiliCookieHeader = body.cookie;
        }
        return json(res, { ok: true });
      }
      if (req.method === "GET" && url.pathname === "/api/translated-subtitles") {
        const bvid = url.searchParams.get("bvid");
        if (!bvid) return json(res, { error: "bvid required" }, 400);
        const cached = await translationForBvid(bvid) || await cachedFeedTranslation(bvid);
        if (!cached) return text(res, "not found", 404);
        return json(res, cached);
      }
      if (req.method === "POST" && url.pathname === "/api/translate-subtitles") {
        const body = await readJson(req);
        const bvid = body?.bvid;
        const entries = body?.entries;
        if (!bvid || !Array.isArray(entries) || !entries.length) {
          console.error("[translate-subtitles] BAD REQUEST: bvid=%s entries=%s", bvid, Array.isArray(entries) ? entries.length : typeof entries);
          return json(res, { error: "bvid and entries required" }, 400);
        }
        const cached = await translationForBvid(bvid);
        if (cached) return json(res, cached);
        try {
          const translated = await translateSubtitleEntries(entries, config);
          const translatedCount = translated.filter((e) => e.translation).length;
          if (!translatedCount) {
            console.error("[translate-subtitles] FAIL: Gemini returned zero translations for %s (%d entries)", bvid, entries.length);
          }
          const cachedTranslation = await writeCachedTranslation(bvid, translated);
          return json(res, cachedTranslation || { bvid, entries: translated });
        } catch (e) {
          console.error("[translate-subtitles] FAIL for %s (%d entries):", bvid, entries.length, e);
          return json(res, { error: e.message || String(e) }, 500);
        }
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
        const updateFeedProgress = (phase, message, details = {}) => {
          feedProgress = feedProgressState(phase, message, true, feedProgress.startedAt, details);
        };
        updateFeedProgress("cache", refresh ? "Skipping cache because refresh was requested." : "Checking cached approved videos.");
        try {
          const cached = refresh ? [] : await readCachedFeed();
          const cachedPolicy = refresh || !cached.length ? FEED_POLICY_VERSION : await readCachedFeedPolicy();
          const staleCachedFeed = cached.length > 0 && cachedPolicy !== FEED_POLICY_VERSION;
          if (staleCachedFeed) {
            updateFeedProgress("cache", "Cached feed is stale; rebuilding.");
            await writeCachedFeed([]);
          }
          const cachedSuggestions = refresh ? [] : await readCachedSuggestions();
          const useCached = cached.length && !staleCachedFeed && !cachedFeedNeedsRefresh(cached, cachedSuggestions, config.suggestions.feedSize);
          const result = useCached
            ? { items: cached, diagnostics: cachedFeedDiagnostics(cached) }
            : await approvedFeedResult(config, { refresh, onProgress: updateFeedProgress });
          if (staleCachedFeed) {
            result.diagnostics.warnings.unshift("Cached feed was rebuilt because the Bilibili subtitle policy changed.");
          }
          updateFeedProgress("render", "Preparing approved videos for display.", { count: result.items.length });
          const items = await Promise.all(result.items.map(publicCachedVideo));
          feedItems.clear();
          for (const item of items) feedItems.set(item.id, item);
          feedProgress = feedProgressState("done", `Ready: ${items.length} approved video${items.length === 1 ? "" : "s"}.`, false, feedProgress.startedAt, { count: items.length });
          return json(res, { items, diagnostics: result.diagnostics });
        } catch (error) {
          feedProgress = feedProgressState("error", error.message || String(error), false, feedProgress.startedAt);
          throw error;
        }
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
      if (req.method === "GET" && url.pathname === "/api/bilibili/subtitle-tracks") {
        const bvid = url.searchParams.get("bvid");
        if (!bvid) return json(res, { error: "bvid required" }, 400);
        try {
          const viewRes = await fetchJsonViaNode(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`);
          const cid = viewRes?.data?.cid;
          const params = new URLSearchParams({ bvid, cid: String(cid || "") }).toString();
          const playerRes = await fetchJsonViaNode(`https://api.bilibili.com/x/player/v2?${params}`);
          const tracks = mergeSubtitleTrackLists(
            viewRes?.data?.subtitle?.list,
            playerRes?.data?.subtitle?.subtitles,
            playerRes?.data?.subtitle?.list
          );
          return json(res, { bvid, cid, tracks });
        } catch (e) {
          console.error("[subtitle-tracks] error for bvid=%s:", bvid, e.message);
          return json(res, { bvid, tracks: [], error: e.message }, 500);
        }
      }
      if (req.method === "GET" && url.pathname === "/api/bilibili/subtitle-json") {
        const subtitleUrl = url.searchParams.get("url");
        if (!subtitleUrl) return json(res, { error: "url required" }, 400);
        try {
          const fullUrl = subtitleUrl.startsWith("//") ? `https:${subtitleUrl}` : subtitleUrl;
          const data = await fetchJsonViaNode(fullUrl);
          return json(res, data);
        } catch (e) {
          console.error("[subtitle-json] fetch error:", e.message);
          return json(res, { error: e.message }, 500);
        }
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
  return server;
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
  const progress = typeof options.onProgress === "function" ? options.onProgress : () => {};
  progress("preferences", "Reading saved prompt and blocked words.");
  const filter = await readFilter();
  if (!filter) return { items: [], diagnostics: emptyDiagnostics() };

  const refresh = Boolean(options.refresh);
  progress("sources", refresh ? "Refreshing YouTube and Bilibili recommendations." : "Loading YouTube recommendations and cached Bilibili suggestions.");
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

  progress("filter", `Checking subtitles for ${candidates.filter((item) => item.platform === "bilibili").length} Bilibili candidate${candidates.filter((item) => item.platform === "bilibili").length === 1 ? "" : "s"}.`, { candidates: candidates.length });
  const blockKeywords = await readBlockKeywords(config.blockKeywords);
  const subtitleFiltered = await applyBilibiliSubtitlePrefilter(candidates, config);
  progress("filter", `Applying blocked words to ${subtitleFiltered.allowed.length} candidate${subtitleFiltered.allowed.length === 1 ? "" : "s"}.`);
  const prefiltered = applyKeywordPrefilter(subtitleFiltered.allowed, blockKeywords);
  progress("classify", `Asking Gemini to classify ${prefiltered.allowed.length} candidate${prefiltered.allowed.length === 1 ? "" : "s"}.`);
  const gated = await classifyInBatches({ intent: filter, candidates: prefiltered.allowed, config, batchSize: 24 });
  progress("search", "Searching Bilibili if the approved feed is short.");
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
  progress("translate", `Ensuring subtitle translations are cached for ${selection.items.filter((item) => item.platform === "bilibili").length} selected Bilibili video${selection.items.filter((item) => item.platform === "bilibili").length === 1 ? "" : "s"}.`);
  await preTranslateChineseSubtitles(selection.items, config, progress);
  const readySelection = await translatedReadySelection(selection);
  progress("metadata", `Loading missing thumbnails for ${readySelection.items.length} approved video${readySelection.items.length === 1 ? "" : "s"}.`);
  const hydrated = await hydrateMissingThumbnails(readySelection.items, config);
  progress("save", "Saving approved feed cache.");
  const feed = await Promise.all(hydrated.map(publicVideo));
  const diagnostics = buildFeedDiagnostics({
    candidates,
    subtitleBlocked: allSubtitleBlocked,
    keywordBlocked: allKeywordBlocked,
    gated: allGated,
    approvedPool: approved,
    feed: hydrated,
    selection: readySelection,
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

  const subtitleFiltered = await applyBilibiliSubtitlePrefilter(searchCandidates, config);
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

export async function applyBilibiliSubtitlePrefilter(candidates = [], config) {
  const allowed = [];
  const blocked = [];
  for (const candidate of candidates) {
    if (candidate.platform !== "bilibili") {
      allowed.push(candidate);
      continue;
    }
    try {
      const parsed = parseVideoUrl(candidate.url || "");
      const cachedTranslation = parsed?.id ? await translationForBvid(parsed.id, candidate.subtitleTranslation) : null;
      if (cachedTranslation?.entries?.length) {
        allowed.push({ ...candidate, subtitleEligibility: "chinese-needs-translation", subtitleTranslation: cachedTranslation });
        continue;
      }
      const subtitleTracks = await bilibiliSubtitleTracksForUrl(candidate.url);
      const englishSubtitleTracks = englishCapableBilibiliSubtitleTracks(subtitleTracks);
      if (englishSubtitleTracks.length) {
        const verifiedTrack = englishSubtitleTracks.find((t) => t.url);
        let subtitleVerified = false;
        if (verifiedTrack) {
          try {
            const subtitleBody = await fetchBilibiliSubtitleJson(verifiedTrack.url);
            subtitleVerified = Array.isArray(subtitleBody) && subtitleBody.length > 0;
          } catch {}
        }
        if (subtitleVerified) {
          allowed.push({ ...candidate, subtitleTracks, englishSubtitleTracks, subtitleEligibility: "english-verified" });
        } else {
          blocked.push(blockBilibiliSubtitleCandidate(candidate, "Bilibili English subtitle track listed but content not yet available."));
        }
        continue;
      }
      if (!subtitleTracks.length) {
        blocked.push(blockBilibiliSubtitleCandidate(candidate, "Bilibili video has no detectable subtitle tracks."));
        continue;
      }
      const chineseTracks = chineseBilibiliSubtitleTracks(subtitleTracks);
      const downloadableChineseTracks = chineseTracks.filter((track) => track.subtitle_url || track.url);
      if (downloadableChineseTracks.length) {
        allowed.push({ ...candidate, subtitleTracks, subtitleEligibility: "chinese-needs-translation" });
        continue;
      }
      if (chineseTracks.length) {
        blocked.push(blockBilibiliSubtitleCandidate(candidate, "Bilibili Chinese subtitle track listed but content not yet available."));
        continue;
      }
      blocked.push(blockBilibiliSubtitleCandidate(candidate, "Bilibili video has subtitles, but no English-capable or translatable subtitle track."));
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

async function publicVideo(item) {
  const parsed = parseVideoUrl(item.url);
  const bvid = parsed?.platform === "bilibili" ? parsed.id : null;
  const translation = bvid ? await translationForBvid(bvid, item.subtitleTranslation) : null;
  return {
    id: item.id,
    platform: item.platform,
    title: item.gate?.safeTitle || item.title,
    uploader: item.uploader,
    durationSeconds: item.durationSeconds,
    thumbnail: item.platform === "bilibili" ? thumbnailProxyPath(item.thumbnail) || item.thumbnail : item.thumbnail,
    url: item.url,
    subtitleEligibility: item.subtitleEligibility,
    subtitleTranslation: translation || undefined
  };
}

async function publicCachedVideo(item) {
  const parsed = parseVideoUrl(item.url);
  const bvid = parsed?.platform === "bilibili" ? parsed.id : null;
  const translation = bvid ? await translationForBvid(bvid, item.subtitleTranslation) : item.subtitleTranslation;
  return {
    ...item,
    thumbnail: item.platform === "bilibili" ? thumbnailProxyPath(item.thumbnail) || item.thumbnail : item.thumbnail,
    subtitleTranslation: translation || undefined
  };
}

async function translationForBvid(bvid, fallback = null) {
  return getCachedTranslation(bvid) || await readCachedTranslation(bvid) || fallback || null;
}

function mergeSubtitleTrackLists(...trackLists) {
  const seen = new Set();
  const tracks = [];
  for (const list of trackLists) {
    if (!Array.isArray(list)) continue;
    for (const track of list) {
      const key = [
        track?.lan || track?.language || "",
        track?.lan_doc || track?.label || track?.name || "",
        track?.subtitle_url || track?.url || ""
      ].join(":");
      if (seen.has(key)) continue;
      seen.add(key);
      tracks.push(track);
    }
  }
  return tracks;
}

async function cachedFeedTranslation(bvid) {
  const cachedFeed = await readCachedFeed();
  for (const item of cachedFeed) {
    const parsed = parseVideoUrl(item.url || "");
    if (parsed?.platform === "bilibili" && parsed.id === bvid && item.subtitleTranslation?.entries?.length) {
      return item.subtitleTranslation;
    }
  }
  return null;
}

async function translatedReadySelection(selection) {
  const items = [];
  const dropped = [];
  for (const item of selection.items) {
    const parsed = parseVideoUrl(item.url || "");
    if (parsed?.platform === "bilibili" && item.subtitleEligibility === "chinese-needs-translation") {
      const translation = await translationForBvid(parsed.id, item.subtitleTranslation);
      if (!translation?.entries?.length) {
        dropped.push(item);
        continue;
      }
      items.push({ ...item, subtitleTranslation: translation });
      continue;
    }
    items.push(item);
  }
  const warnings = [...(selection.warnings || [])];
  if (dropped.length) {
    warnings.push(`${dropped.length} approved Bilibili video${dropped.length === 1 ? "" : "s"} withheld until subtitle translation is cached.`);
  }
  return {
    ...selection,
    items,
    feedByPlatform: countBy(items, (item) => item.platform),
    warnings
  };
}

async function preTranslateChineseSubtitles(items, config, progress = () => {}) {
  const cookie = globalThis.__intentBilibiliCookie?.() || "";
  async function fetchJson(url) {
    const headers = {
      accept: "application/json",
      referer: "https://www.bilibili.com/",
      "user-agent": "Mozilla/5.0"
    };
    if (cookie) headers.cookie = cookie;
    const response = await fetch(url, { headers });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  }
  for (const item of items) {
    if (item.subtitleEligibility !== "chinese-needs-translation") continue;
    const parsed = parseVideoUrl(item.url);
    if (!parsed?.id) continue;
    const bvid = parsed.id;
    if (await translationForBvid(bvid)) {
      progress("translate", `Using cached subtitle translation for ${bvid}.`);
      continue;
    }
    try {
      progress("translate", `Downloading Chinese subtitles for ${bvid}.`);
      let cnTrack = chineseBilibiliSubtitleTracks(item.subtitleTracks || [])[0];
      if (!cnTrack) {
        const viewRes = await fetchJson(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`);
        const cid = viewRes?.data?.cid;
        if (!cid) continue;
        const playerRes = await fetchJson(`https://api.bilibili.com/x/player/v2?bvid=${encodeURIComponent(bvid)}&cid=${encodeURIComponent(cid)}`);
        const tracks = playerRes?.data?.subtitle?.subtitles || playerRes?.data?.subtitle?.list || [];
        cnTrack = tracks.find(t => /zh|中文|Chinese/i.test(`${t.lan || ""} ${t.lan_doc || ""}`) && (t.subtitle_url || t.url));
      }
      if (!cnTrack) continue;
      const trackUrl = cnTrack.subtitle_url || cnTrack.url;
      const subUrl = trackUrl.startsWith("//") ? `https:${trackUrl}` : trackUrl;
      const subData = await fetchJson(subUrl);
      const entries = Array.isArray(subData?.body) ? subData.body : null;
      if (!entries?.length) continue;
      progress("translate", `Translating ${entries.length} subtitle line${entries.length === 1 ? "" : "s"} for ${bvid}.`);
      const translated = await translateSubtitleEntries(entries, config);
      if (translated?.length) {
        await writeCachedTranslation(bvid, translated);
        progress("translate", `Cached subtitle translation for ${bvid}.`);
      }
    } catch (e) {
      console.error(`[pre-translate] failed for ${bvid}:`, e.message);
    }
  }
}

function feedProgressState(phase, message, active = false, startedAt = null, details = {}) {
  const now = new Date().toISOString();
  const start = startedAt || now;
  return {
    active,
    phase,
    message,
    startedAt: start,
    updatedAt: now,
    elapsedMs: Date.parse(now) - Date.parse(start),
    ...details
  };
}

function currentFeedProgress(progress) {
  if (!progress?.active || !progress.startedAt) return progress;
  return {
    ...progress,
    elapsedMs: Date.now() - Date.parse(progress.startedAt)
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
  if (cachedFeed.some((item) => item.platform === "bilibili" && item.subtitleEligibility === "chinese-needs-translation" && !item.subtitleTranslation?.entries?.length)) {
    return true;
  }
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
