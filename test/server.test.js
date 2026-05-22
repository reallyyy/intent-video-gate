import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config.js";
import { paths, useProjectLocalPaths } from "../src/paths.js";
import { FEED_POLICY_VERSION, readCachedFeedPolicy, readCachedSuggestions, writeCachedFeed } from "../src/store.js";
import { applyBilibiliSubtitlePrefilter, applyKeywordPrefilter, approvedFeedResult, createApp, selectFeedCandidates, selectFinalFeed } from "../src/server.js";

test("pre-classification candidates include YouTube when Bilibili cache is full", () => {
  const cachedBilibili = Array.from({ length: 80 }, (_, index) => ({
    id: `bilibili:cached-${index}`,
    platform: "bilibili",
    title: `Bilibili cached video ${index}`,
    url: `https://www.bilibili.com/video/BVcached${String(index).padStart(2, "0")}`
  }));
  const youtubeItems = Array.from({ length: 8 }, (_, index) => ({
    id: `youtube:yt-${index}`,
    platform: "youtube",
    title: `YouTube recommendation ${index}`,
    url: `https://www.youtube.com/watch?v=yt-${index}`
  }));

  const candidates = selectFeedCandidates({ cachedBilibili, youtubeItems, limit: 80 });
  const platforms = candidates.map((item) => item.platform);

  assert.equal(candidates.length, 80);
  assert.equal(platforms.filter((platform) => platform === "youtube").length, 8);
  assert.equal(platforms.filter((platform) => platform === "bilibili").length, 72);
});

test("keyword prefilter blocks matching candidates before AI classification", () => {
  const candidates = [
    {
      id: "bilibili:warhammer",
      platform: "bilibili",
      title: "少女战锤 lore clip",
      uploader: "Uploader",
      url: "https://www.bilibili.com/video/BVblocked"
    },
    {
      id: "bilibili:music",
      platform: "bilibili",
      title: "Warm melodic music video",
      uploader: "Musician",
      url: "https://www.bilibili.com/video/BVmusic"
    }
  ];

  const result = applyKeywordPrefilter(candidates, ["战锤"]);

  assert.deepEqual(result.allowed.map((item) => item.id), ["bilibili:music"]);
  assert.deepEqual(result.blocked.map((item) => item.id), ["bilibili:warhammer"]);
  assert.equal(result.blocked[0].gate.reason, "Blocked by keyword: 战锤");
});

test("music candidates are not locally blocked without keyword matches", () => {
  const candidates = [
    {
      id: "bilibili:music",
      platform: "bilibili",
      title: "Atmospheric bittersweet indie song",
      uploader: "Musician",
      url: "https://www.bilibili.com/video/BVmusic"
    }
  ];

  const result = applyKeywordPrefilter(candidates, ["warhammer", "道士"]);

  assert.equal(result.allowed.length, 1);
  assert.equal(result.blocked.length, 0);
});

test("Bilibili subtitle prefilter blocks CN-only and zero-track videos", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("BVwithenglish") && url.includes("api.bilibili.com")) {
      return jsonResponse({ code: 0, data: { subtitle: { list: [{ lan: "en-US", lan_doc: "English", subtitle_url: "//example.com/en-sub.json" }] } } });
    }
    if (url.includes("BVwithbilingual") && url.includes("api.bilibili.com")) {
      return jsonResponse({ code: 0, data: { subtitle: { list: [{ lan: "ai-zh", lan_doc: "中文 AI 双语字幕", subtitle_url: "//example.com/bi-sub.json" }] } } });
    }
    if (url.includes("BVcnonly") && url.includes("api.bilibili.com")) {
      return jsonResponse({ code: 0, data: { subtitle: { list: [{ lan: "zh-CN", lan_doc: "中文（自动生成）" }] } } });
    }
    if (url.includes("BVnosubs") && url.includes("api.bilibili.com")) {
      return jsonResponse({ code: 0, data: { subtitle: { list: [] } } });
    }
    if (url.includes("example.com/en-sub.json")) {
      return jsonResponse({ body: [{ from: 0, to: 5, content: "Hello" }] });
    }
    if (url.includes("example.com/bi-sub.json")) {
      return jsonResponse({ body: [{ from: 0, to: 5, content: "你好 Hello" }] });
    }
    return jsonResponse({ code: 0, data: { subtitle: { subtitles: [] } } });
  };
  try {
    const result = await applyBilibiliSubtitlePrefilter([
      {
        id: "youtube:1",
        platform: "youtube",
        title: "YouTube",
        url: "https://www.youtube.com/watch?v=abc"
      },
      {
        id: "bilibili:BVwithenglish",
        platform: "bilibili",
        title: "Bilibili with English subtitles",
        url: "https://www.bilibili.com/video/BVwithenglish"
      },
      {
        id: "bilibili:BVwithbilingual",
        platform: "bilibili",
        title: "Bilibili with bilingual subtitles",
        url: "https://www.bilibili.com/video/BVwithbilingual"
      },
      {
        id: "bilibili:BVcnonly",
        platform: "bilibili",
        title: "Bilibili with Chinese AI subtitles only",
        url: "https://www.bilibili.com/video/BVcnonly"
      },
      {
        id: "bilibili:BVnosubs",
        platform: "bilibili",
        title: "Bilibili without subtitles",
        url: "https://www.bilibili.com/video/BVnosubs"
      }
    ]);

    assert.deepEqual(result.allowed.map((item) => item.id), ["youtube:1", "bilibili:BVwithenglish", "bilibili:BVwithbilingual"]);
    assert.deepEqual(result.blocked.map((item) => item.id), ["bilibili:BVcnonly", "bilibili:BVnosubs"]);
    assert.equal(result.allowed[1].subtitleTracks.length, 1);
    assert.equal(result.allowed[1].englishSubtitleTracks.length, 1);
    assert.equal(result.allowed[2].subtitleEligibility, "english-verified");
    assert.match(result.blocked[0].gate.reason, /no English-capable or translatable/);
    assert.match(result.blocked[1].gate.reason, /no detectable subtitle tracks/);
    assert.equal(result.blocked[0].gate.labels[0], "bilibili-subtitle-required");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Bilibili subtitle prefilter blocks English track with empty subtitle_url", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("BVemptyurl")) {
      return jsonResponse({ code: 0, data: { subtitle: { list: [{ lan: "ai-en", lan_doc: "英文（AI生成）", subtitle_url: "" }] } } });
    }
    return jsonResponse({ code: 0, data: {} });
  };
  try {
    const result = await applyBilibiliSubtitlePrefilter([
      {
        id: "bilibili:BVemptyurl",
        platform: "bilibili",
        title: "Bilibili with empty English URL",
        url: "https://www.bilibili.com/video/BVemptyurl"
      }
    ]);
    assert.equal(result.allowed.length, 0);
    assert.equal(result.blocked.length, 1);
    assert.match(result.blocked[0].gate.reason, /no English-capable or translatable/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Bilibili subtitle prefilter blocks English track when subtitle download fails", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("BVdownloadfail") && url.includes("api.bilibili.com")) {
      return jsonResponse({ code: 0, data: { subtitle: { list: [{ lan: "en-US", lan_doc: "English", subtitle_url: "//broken.example.com/sub.json" }] } } });
    }
    if (url.includes("broken.example.com")) {
      return { ok: false, status: 404, json: async () => ({}) };
    }
    return jsonResponse({ code: 0, data: {} });
  };
  try {
    const result = await applyBilibiliSubtitlePrefilter([
      {
        id: "bilibili:BVdownloadfail",
        platform: "bilibili",
        title: "Bilibili with broken subtitle URL",
        url: "https://www.bilibili.com/video/BVdownloadfail"
      }
    ]);
    assert.equal(result.allowed.length, 0);
    assert.equal(result.blocked.length, 1);
    assert.match(result.blocked[0].gate.reason, /content not yet available/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Bilibili subtitle prefilter allows Chinese-only video with cached translation", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("BVcachedtrans") && url.includes("api.bilibili.com")) {
      return jsonResponse({ code: 0, data: { subtitle: { list: [{ lan: "ai-zh", lan_doc: "中文", subtitle_url: "//example.com/cn-sub.json" }] } } });
    }
    return jsonResponse({ code: 0, data: {} });
  };
  try {
    const result = await applyBilibiliSubtitlePrefilter([
      {
        id: "bilibili:BVcachedtrans",
        platform: "bilibili",
        title: "Chinese-only Bilibili video with cached translation",
        url: "https://www.bilibili.com/video/BVcachedtrans"
      }
    ], {});
    assert.equal(result.allowed.length, 1);
    assert.equal(result.allowed[0].subtitleEligibility, "chinese-needs-translation");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Bilibili subtitle prefilter allows Chinese-only video with downloadable track", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("BVchineseurl") && url.includes("api.bilibili.com")) {
      return jsonResponse({ code: 0, data: { subtitle: { list: [{ lan: "ai-zh", lan_doc: "中文", subtitle_url: "//example.com/cn.json" }] } } });
    }
    return jsonResponse({ code: 0, data: {} });
  };
  try {
    const result = await applyBilibiliSubtitlePrefilter([
      {
        id: "bilibili:BVchineseurl",
        platform: "bilibili",
        title: "Chinese-only Bilibili video",
        url: "https://www.bilibili.com/video/BVchineseurl"
      }
    ], {});
    assert.equal(result.allowed.length, 1);
    assert.equal(result.allowed[0].subtitleEligibility, "chinese-needs-translation");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("writeCachedFeed records the active feed policy version", async () => {
  const root = await mkdtemp(join(tmpdir(), "intent-video-server-test-"));
  useProjectLocalPaths(root);
  try {
    await writeCachedFeed([
      {
        id: "youtube:cached",
        platform: "youtube",
        title: "Cached YouTube",
        url: "https://www.youtube.com/watch?v=cached"
      }
    ]);

    assert.equal(await readCachedFeedPolicy(), FEED_POLICY_VERSION);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("feed API ignores stale cached Bilibili videos from before subtitle policy", async () => {
  const state = await isolatedStateWithFakeTools({ suggestions: [] });
  await writeFile(paths.cacheFile, JSON.stringify({
    suggestions: [],
    feed: [
      {
        id: "bilibili:BV1xE411Z7JH",
        platform: "bilibili",
        title: "Historical Documentary: Xiang Yu",
        uploader: "Fitou",
        durationSeconds: 5968,
        thumbnail: "",
        url: "https://www.bilibili.com/video/BV1xE411Z7JH"
      }
    ],
    feedUpdatedAt: new Date().toISOString()
  }, null, 2) + "\n");
  const api = await listenApp(state.config);
  try {
    const result = await requestJson(api.url, "/api/feed");

    assert.equal(result.items.some((item) => item.id === "bilibili:BV1xE411Z7JH"), false);
    assert.equal(result.items.every((item) => item.platform !== "bilibili"), true);
    assert.match(result.diagnostics.warnings.join(" "), /Bilibili subtitle policy changed/);
    assert.equal(await readCachedFeedPolicy(), FEED_POLICY_VERSION);
  } finally {
    await api.close();
    await rm(state.root, { recursive: true, force: true });
  }
});

test("feed API serves current-policy cached feed without rebuilding", async () => {
  const state = await isolatedStateWithFakeTools({ suggestions: [] });
  await writeFile(paths.cacheFile, JSON.stringify({
    suggestions: [],
    feedPolicyVersion: FEED_POLICY_VERSION,
    feed: [
      {
        id: "youtube:current-cache",
        platform: "youtube",
        title: "Current cached YouTube",
        uploader: "YouTube",
        durationSeconds: 120,
        thumbnail: "",
        url: "https://www.youtube.com/watch?v=current-cache"
      }
    ],
    feedUpdatedAt: new Date().toISOString()
  }, null, 2) + "\n");
  const api = await listenApp(state.config);
  try {
    const result = await requestJson(api.url, "/api/feed");

    assert.deepEqual(result.items.map((item) => item.id), ["youtube:current-cache"]);
    assert.equal(result.diagnostics.cached, true);
  } finally {
    await api.close();
    await rm(state.root, { recursive: true, force: true });
  }
});

test("feed API preserves persisted cached Bilibili subtitle translations", async () => {
  const state = await isolatedStateWithFakeTools({ suggestions: [] });
  await writeFile(paths.cacheFile, JSON.stringify({
    suggestions: [],
    feedPolicyVersion: FEED_POLICY_VERSION,
    feed: [
      {
        id: "bilibili:BVcachedtranslation",
        platform: "bilibili",
        title: "Cached translated Bilibili",
        uploader: "Bilibili",
        durationSeconds: 120,
        thumbnail: "",
        url: "https://www.bilibili.com/video/BVcachedtranslation",
        subtitleTranslation: {
          bvid: "BVcachedtranslation",
          translatedAt: "2026-05-22T00:00:00.000Z",
          entries: [{ from: 0, to: 5, content: "你好", translation: "Hello" }]
        }
      }
    ],
    feedUpdatedAt: new Date().toISOString()
  }, null, 2) + "\n");
  const api = await listenApp(state.config);
  try {
    const feed = await requestJson(api.url, "/api/feed");
    const translated = await requestJson(api.url, "/api/translated-subtitles?bvid=BVcachedtranslation");

    assert.equal(feed.items[0].subtitleTranslation.entries[0].translation, "Hello");
    assert.equal(translated.entries[0].translation, "Hello");
  } finally {
    await api.close();
    await rm(state.root, { recursive: true, force: true });
  }
});

test("feed API serves durable Bilibili subtitle translations from cache root", async () => {
  const state = await isolatedStateWithFakeTools({ suggestions: [] });
  await writeFile(paths.cacheFile, JSON.stringify({
    suggestions: [],
    feedPolicyVersion: FEED_POLICY_VERSION,
    subtitleTranslations: {
      BVdurabletranslation: {
        bvid: "BVdurabletranslation",
        translatedAt: "2026-05-22T00:00:00.000Z",
        entries: [{ from: 0, to: 5, content: "你好", translation: "Hello" }]
      }
    },
    feed: [
      {
        id: "bilibili:BVdurabletranslation",
        platform: "bilibili",
        title: "Durably translated Bilibili",
        uploader: "Bilibili",
        durationSeconds: 120,
        thumbnail: "",
        url: "https://www.bilibili.com/video/BVdurabletranslation",
        subtitleTranslation: {
          bvid: "BVdurabletranslation",
          entries: [{ from: 0, to: 5, content: "old", translation: "Old" }]
        }
      }
    ],
    feedUpdatedAt: new Date().toISOString()
  }, null, 2) + "\n");
  const api = await listenApp(state.config);
  try {
    const feed = await requestJson(api.url, "/api/feed");
    const translated = await requestJson(api.url, "/api/translated-subtitles?bvid=BVdurabletranslation");

    assert.equal(feed.items[0].subtitleTranslation.entries[0].translation, "Hello");
    assert.equal(translated.entries[0].translation, "Hello");
  } finally {
    await api.close();
    await rm(state.root, { recursive: true, force: true });
  }
});

test("feed API keeps current cached English Bilibili items without translations", async () => {
  const state = await isolatedStateWithFakeTools({ suggestions: [] });
  await writeFile(paths.cacheFile, JSON.stringify({
    suggestions: [
      {
        id: "bilibili:BVenglishcached",
        platform: "bilibili",
        title: "English cached Bilibili suggestion",
        uploader: "Bilibili",
        durationSeconds: 120,
        thumbnail: "",
        url: "https://www.bilibili.com/video/BVenglishcached"
      }
    ],
    feedPolicyVersion: FEED_POLICY_VERSION,
    feed: [
      {
        id: "bilibili:BVenglishcached",
        platform: "bilibili",
        title: "English cached Bilibili",
        uploader: "Bilibili",
        durationSeconds: 120,
        thumbnail: "",
        url: "https://www.bilibili.com/video/BVenglishcached",
        subtitleEligibility: "english-verified"
      }
    ],
    feedUpdatedAt: new Date().toISOString()
  }, null, 2) + "\n");
  const api = await listenApp(state.config);
  try {
    const result = await requestJson(api.url, "/api/feed");

    assert.equal(result.diagnostics.cached, true);
    assert.deepEqual(result.items.map((item) => item.id), ["bilibili:BVenglishcached"]);
    assert.equal(result.items[0].subtitleTranslation, undefined);
  } finally {
    await api.close();
    await rm(state.root, { recursive: true, force: true });
  }
});

test("feed API rebuilds current cached Bilibili items that lack cached translations", async () => {
  const state = await isolatedStateWithFakeTools({ suggestions: [] });
  await writeFile(paths.cacheFile, JSON.stringify({
    suggestions: [],
    feedPolicyVersion: FEED_POLICY_VERSION,
    feed: [
      {
        id: "bilibili:BVmissingtranslation",
        platform: "bilibili",
        title: "Missing translation",
        uploader: "Bilibili",
        durationSeconds: 120,
        thumbnail: "",
        url: "https://www.bilibili.com/video/BVmissingtranslation",
        subtitleEligibility: "chinese-needs-translation"
      }
    ],
    feedUpdatedAt: new Date().toISOString()
  }, null, 2) + "\n");
  const api = await listenApp(state.config);
  try {
    const result = await requestJson(api.url, "/api/feed");

    assert.equal(result.diagnostics.cached, undefined);
    assert.equal(result.items.some((item) => item.id === "bilibili:BVmissingtranslation"), false);
  } finally {
    await api.close();
    await rm(state.root, { recursive: true, force: true });
  }
});

test("Bilibili subtitle track proxy includes view endpoint tracks when player endpoint is empty", async () => {
  const state = await isolatedStateWithFakeTools({ suggestions: [] });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("api.bilibili.com/x/web-interface/view")) {
      return jsonResponse({
        code: 0,
        data: {
          cid: 123,
          subtitle: { list: [{ lan: "ai-en", lan_doc: "English", subtitle_url: "//example.com/view-en.json" }] }
        }
      });
    }
    if (url.includes("api.bilibili.com/x/player/v2")) {
      return jsonResponse({ code: 0, data: { subtitle: { subtitles: [] } } });
    }
    return originalFetch(input);
  };
  const api = await listenApp(state.config);
  try {
    const result = await requestJson(api.url, "/api/bilibili/subtitle-tracks?bvid=BVviewonly");

    assert.equal(result.cid, 123);
    assert.equal(result.tracks.length, 1);
    assert.equal(result.tracks[0].subtitle_url, "//example.com/view-en.json");
  } finally {
    await api.close();
    globalThis.fetch = originalFetch;
    await rm(state.root, { recursive: true, force: true });
  }
});

test("final feed keeps 20 YouTube videos and appends 10 percent Bilibili", () => {
  const approved = [
    ...approvedItems("youtube", 30),
    ...approvedItems("bilibili", 10)
  ];

  const result = selectFinalFeed(approved, 20);

  assert.equal(result.items.length, 22);
  assert.deepEqual(result.targetByPlatform, { youtube: 20, bilibili: 2 });
  assert.equal(result.feedByPlatform.youtube, 20);
  assert.equal(result.feedByPlatform.bilibili, 2);
  assert.deepEqual(result.warnings, []);
});

test("final feed keeps YouTube videos when Bilibili extras are short and warns", () => {
  const approved = [
    ...approvedItems("youtube", 30),
    ...approvedItems("bilibili", 1)
  ];

  const result = selectFinalFeed(approved, 20);

  assert.equal(result.items.length, 21);
  assert.equal(result.feedByPlatform.youtube, 20);
  assert.equal(result.feedByPlatform.bilibili, 1);
  assert.match(result.warnings[0], /Only 1 approved Bilibili video available/);
});

test("final feed warns when no Bilibili videos are approved", () => {
  const result = selectFinalFeed(approvedItems("youtube", 30), 20);

  assert.equal(result.items.length, 20);
  assert.equal(result.feedByPlatform.youtube, 20);
  assert.equal(result.feedByPlatform.bilibili, undefined);
  assert.match(result.warnings[0], /Only 0 approved Bilibili videos available/);
});

test("block keyword API exposes editable defaults and persists custom lists", async () => {
  const api = await startIsolatedApp();
  try {
    const initial = await requestJson(api.url, "/api/block-keywords");
    assert.deepEqual(initial.blockKeywords, defaultConfig.blockKeywords);
    assert.deepEqual(initial.defaultBlockKeywords, defaultConfig.blockKeywords);

    const saved = await requestJson(api.url, "/api/block-keywords", {
      method: "PUT",
      body: JSON.stringify({ blockKeywords: [" warhammer ", "warhammer", "道士"] })
    });
    assert.deepEqual(saved.blockKeywords, ["warhammer", "道士"]);

    const reloaded = await requestJson(api.url, "/api/block-keywords");
    assert.deepEqual(reloaded.blockKeywords, ["warhammer", "道士"]);
  } finally {
    await api.close();
  }
});

test("block keyword API preserves an intentionally empty list", async () => {
  const api = await startIsolatedApp();
  try {
    await requestJson(api.url, "/api/block-keywords", {
      method: "PUT",
      body: JSON.stringify({ blockKeywords: [] })
    });
    const reloaded = await requestJson(api.url, "/api/block-keywords");
    assert.deepEqual(reloaded.blockKeywords, []);
  } finally {
    await api.close();
  }
});

test("collected Bilibili suggestions are canonicalized and deduplicated", async () => {
  const api = await startIsolatedApp();
  try {
    const saved = await requestJson(api.url, "/api/collect-bilibili", {
      method: "POST",
      body: JSON.stringify({
        items: [
          {
            title: "Tracked Bilibili video",
            uploader: "Uploader",
            url: "https://www.bilibili.com/video/BV1xx411c7mD/?spm_id_from=333.788&trackid=abc"
          },
          {
            title: "Tracked Bilibili video duplicate",
            uploader: "Uploader",
            url: "https://www.bilibili.com/video/BV1xx411c7mD"
          }
        ]
      })
    });
    const suggestions = await readCachedSuggestions();

    assert.equal(saved.count, 1);
    assert.equal(suggestions.length, 1);
    assert.equal(suggestions[0].id, "bilibili:BV1xx411c7mD");
    assert.equal(suggestions[0].url, "https://www.bilibili.com/video/BV1xx411c7mD");
  } finally {
    await api.close();
  }
});

test("refresh keeps cached Bilibili candidates when live Bilibili sources fail", async () => {
  const state = await isolatedStateWithFakeTools();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("example.com/test-sub.json")) {
      return jsonResponse({ body: [{ from: 0, to: 5, content: "Test subtitle" }] });
    }
    if (url.includes("api.bilibili.com/x/web-interface/view")) {
      return subtitleMetadataResponse();
    }
    if (url.includes("api.bilibili.com/x/player/v2")) {
      return jsonResponse({ code: 0, data: { subtitle: { subtitles: [] } } });
    }
    if (url.includes("api.bilibili.com")) {
      return { ok: false, status: 503, json: async () => ({ code: -1, message: "unavailable" }) };
    }
    return originalFetch(input, init);
  };
  try {
    const result = await approvedFeedResult(state.config, { refresh: true });
    const platforms = result.items.map((item) => item.platform);

    assert.equal(result.items.length, 21);
    assert.equal(platforms.filter((platform) => platform === "youtube").length, 20);
    assert.equal(platforms.filter((platform) => platform === "bilibili").length, 1);
    assert.equal(result.diagnostics.sources.bilibili.fallback, "cache");
    assert.equal(result.diagnostics.bilibiliSubtitleChecks.blocked, 0);
    assert.match(result.diagnostics.warnings.join(" "), /using cached Bilibili recommendations/);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(state.root, { recursive: true, force: true });
  }
});

test("refresh includes translated subtitles for Chinese-only Bilibili candidates", async () => {
  const state = await isolatedStateWithFakeTools({
    suggestions: [
      {
        id: "bilibili:BVtranslated001",
        platform: "bilibili",
        title: "Chinese-only translated Bilibili video",
        uploader: "Bilibili",
        durationSeconds: 120,
        thumbnail: "",
        url: "https://www.bilibili.com/video/BVtranslated001"
      }
    ]
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("example.com/chinese-sub.json")) {
      return jsonResponse({ body: [{ from: 0, to: 5, content: "你好世界" }] });
    }
    if (url.includes("api.bilibili.com/x/web-interface/view")) {
      return jsonResponse({
        code: 0,
        data: {
          cid: 123,
          subtitle: { list: [{ lan: "ai-zh", lan_doc: "中文", subtitle_url: "//example.com/chinese-sub.json" }] }
        }
      });
    }
    if (url.includes("api.bilibili.com/x/player/v2")) {
      return jsonResponse({ code: 0, data: { subtitle: { subtitles: [] } } });
    }
    if (url.includes("api.bilibili.com")) {
      return { ok: false, status: 503, json: async () => ({ code: -1, message: "unavailable" }) };
    }
    return originalFetch(input, init);
  };
  try {
    const result = await approvedFeedResult(state.config, { refresh: true });
    const item = result.items.find((candidate) => candidate.id === "bilibili:BVtranslated001");

    assert.ok(item, "translated Bilibili candidate should be selected");
    assert.equal(item.subtitleTranslation?.entries?.length, 1);
    assert.equal(item.subtitleTranslation.entries[0].content, "你好世界");
    assert.equal(item.subtitleTranslation.entries[0].translation, "Hello world");
  } finally {
    globalThis.fetch = originalFetch;
    await rm(state.root, { recursive: true, force: true });
  }
});

test("refresh searches Bilibili from Gemini queries when approved Bilibili is short", async () => {
  const state = await isolatedStateWithFakeTools({
    suggestions: [],
    bilisearchItems: [
      {
        id: "BVsearch001",
        title: "High quality Bilibili documentary",
        uploader: "Bilibili",
        duration: 600,
        webpage_url: "https://www.bilibili.com/video/BVsearch001"
      },
      {
        id: "BVsearch002",
        title: "Deep technical Bilibili lecture",
        uploader: "Bilibili",
        duration: 900,
        webpage_url: "https://www.bilibili.com/video/BVsearch002"
      }
    ]
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("example.com/test-sub.json")) {
      return jsonResponse({ body: [{ from: 0, to: 5, content: "Test subtitle" }] });
    }
    if (url.includes("api.bilibili.com/x/web-interface/view")) {
      return subtitleMetadataResponse();
    }
    if (url.includes("api.bilibili.com/x/player/v2")) {
      return jsonResponse({ code: 0, data: { subtitle: { subtitles: [] } } });
    }
    if (url.includes("api.bilibili.com")) {
      return { ok: false, status: 503, json: async () => ({ code: -1, message: "unavailable" }) };
    }
    return originalFetch(input, init);
  };
  try {
    const result = await approvedFeedResult(state.config, { refresh: true });
    const platforms = result.items.map((item) => item.platform);

    assert.equal(result.items.length, 22);
    assert.equal(platforms.filter((platform) => platform === "youtube").length, 20);
    assert.equal(platforms.filter((platform) => platform === "bilibili").length, 2);
    assert.deepEqual(result.diagnostics.bilibiliSearchQueries, ["高质量纪录片"]);
    assert.equal(result.diagnostics.bilibiliSearchApproved, 2);
    assert.equal(result.diagnostics.bilibiliSubtitleChecks.blocked, 0);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(state.root, { recursive: true, force: true });
  }
});

function approvedItems(platform, count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `${platform}:${index}`,
    platform,
    title: `${platform} approved ${index}`,
    url: platform === "youtube"
      ? `https://www.youtube.com/watch?v=${index}`
      : `https://www.bilibili.com/video/BV${String(index).padStart(10, "0")}`,
    gate: { decision: "allow", safeTitle: `${platform} approved ${index}` }
  }));
}

function subtitleMetadataResponse() {
  return jsonResponse({ code: 0, data: { subtitle: { list: [{ lan: "en-US", lan_doc: "English", subtitle_url: "//example.com/test-sub.json" }] } } });
}

function jsonResponse(payload, ok = true, status = 200) {
  return { ok, status, json: async () => payload };
}

async function startIsolatedApp() {
  const root = await mkdtemp(join(tmpdir(), "intent-video-server-test-"));
  useProjectLocalPaths(root);
  const api = await listenApp(defaultConfig);
  return {
    url: api.url,
    close: async () => {
      await api.close();
      await rm(root, { recursive: true, force: true });
    }
  };
}

async function listenApp(config) {
  const app = createApp(config);
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  const { port } = app.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      await new Promise((resolve, reject) => app.close((error) => error ? reject(error) : resolve()));
    }
  };
}

async function isolatedStateWithFakeTools({ suggestions, bilisearchItems = [] } = {}) {
  const root = await mkdtemp(join(tmpdir(), "intent-video-server-test-"));
  useProjectLocalPaths(root);
  await mkdir(paths.configDir, { recursive: true });
  await mkdir(paths.dataDir, { recursive: true });
  await writeFile(paths.configFile, JSON.stringify({ filter: "allow useful test videos", blockKeywords: [] }, null, 2) + "\n");
  await writeFile(paths.cacheFile, JSON.stringify({
    suggestions: suggestions || [
      {
        id: "bilibili:BVcached001",
        platform: "bilibili",
        title: "Cached Bilibili video",
        uploader: "Bilibili",
        durationSeconds: 120,
        thumbnail: "",
        url: "https://www.bilibili.com/video/BVcached001?spm_id_from=333.788"
      }
    ],
    feed: []
  }, null, 2) + "\n");

  const gemini = join(root, "gemini");
  const ytdlp = join(root, "yt-dlp");
await writeFile(gemini, `#!/usr/bin/env node
const promptIndex = process.argv.indexOf("-p");
const prompt = promptIndex >= 0 ? process.argv[promptIndex + 1] || "" : "";
const marker = "Candidates:";
if (prompt.startsWith("Translate these Chinese subtitle lines")) {
  process.stdout.write(JSON.stringify({ response: JSON.stringify(["Hello world"]) }));
  process.exit(0);
}
if (!prompt.includes(marker)) {
  process.stdout.write(JSON.stringify({ response: JSON.stringify({ queries: ["高质量纪录片"] }) }));
  process.exit(0);
}
const candidates = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length).trim());
const decisions = candidates.map((candidate) => ({
  id: candidate.id,
  decision: "allow",
  confidence: 1,
  reason: "test",
  labels: ["test"],
  safe_title: candidate.title
}));
process.stdout.write(JSON.stringify({ response: JSON.stringify({ decisions }) }));
`, "utf8");
await writeFile(ytdlp, `#!/usr/bin/env node
const args = process.argv.slice(2);
const target = args.find((arg) => arg.startsWith("bilisearch") || arg.includes("bilibili.com") || arg.includes("youtube.com")) || "";
if (target.startsWith("bilisearch")) {
  const items = ${JSON.stringify(bilisearchItems)};
  process.stdout.write(items.map((item) => JSON.stringify(item)).join("\\n") + (items.length ? "\\n" : ""));
  process.exit(0);
}
if (target.includes("bilibili.com")) {
  process.stderr.write("Bilibili unavailable\\n");
  process.exit(1);
}
const items = Array.from({ length: 24 }, (_, index) => ({
  id: "yt-refresh-" + index,
  title: "YouTube refresh " + index,
  uploader: "YouTube",
  duration: 90,
  webpage_url: "https://www.youtube.com/watch?v=yt-refresh-" + index
}));
process.stdout.write(items.map((item) => JSON.stringify(item)).join("\\n") + "\\n");
`, "utf8");
  await chmod(gemini, 0o755);
  await chmod(ytdlp, 0o755);

  return {
    root,
    config: {
      ...defaultConfig,
      gemini: { ...defaultConfig.gemini, command: gemini, retries: 1 },
      tools: { ...defaultConfig.tools, ytdlp },
      suggestions: { ...defaultConfig.suggestions, maxCollected: 80, feedSize: 20 }
    }
  };
}

async function requestJson(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) }
  });
  const body = await response.json();
  assert.equal(response.ok, true, body.error || `HTTP ${response.status}`);
  return body;
}
