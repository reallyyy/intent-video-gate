const APP = "http://127.0.0.1:47231";
let lastPlayerResizeAt = 0;
let lastAuthReport = "";
const bilibiliSubtitleState = {
  bvid: "",
  metadataPromise: null,
  subtitleAvailable: false,
  englishSubtitleAvailable: false,
  subtitleTracks: [],
  chineseJson: null,
  englishJson: null,
  bilingualSingleTrack: false,
  overlayActive: false,
  overlayElement: null
};

updateWatchStageSize();
installPanel();
markPage();
detectAndReportAuth();
hideDistractions();
focusYouTubeWatch();
focusBilibiliWatch();
relayBilibiliCookies();
syncSubtitleTranslations();
setInterval(detectAndReportAuth, 2000);
setInterval(hideDistractions, 1500);
setInterval(focusYouTubeWatch, 1500);
setInterval(focusBilibiliWatch, 1500);
setInterval(enhanceBilibiliStackedSubtitles, 700);
setTimeout(collectSuggestions, 1800);
setInterval(collectSuggestions, 15000);
setInterval(relayBilibiliCookies, 5 * 60 * 1000);
window.addEventListener("resize", () => {
  updateWatchStageSize();
  nudgePlayerResize();
});
window.visualViewport?.addEventListener("resize", () => {
  updateWatchStageSize();
  nudgePlayerResize();
});

function relayBilibiliCookies() {
  if (!globalThis.chrome?.runtime?.sendMessage) return;
  chrome.runtime.sendMessage({ type: "intent:relayCookies" }, (response) => {
    if (chrome.runtime.lastError) {
      console.error("[intent-video] relayBilibiliCookies error:", chrome.runtime.lastError.message);
    }
  });
}

function installPanel() {
  if (document.getElementById("intent-video-panel")) return;
  const panel = document.createElement("div");
  panel.id = "intent-video-panel";
  const link = document.createElement("a");
  link.href = APP;
  link.textContent = "Back to Intent Gate";
  panel.append(link);
  document.documentElement.append(panel);
}

async function syncSubtitleTranslations() {
  if (location.protocol === "https:") return;
  try {
    const res = await fetch(`${APP}/api/feed`);
    const data = await res.json();
    const translations = {};
    for (const item of (data.items || [])) {
      if (item.subtitleTranslation) {
        const bvid = item.url?.match(/BV[\w]+/)?.[0];
        const entries = normalizeTranslationEntries(item.subtitleTranslation);
        if (bvid && entries.length) translations[bvid] = entries;
      }
    }
    if (Object.keys(translations).length) {
      await new Promise(r => chrome.storage.local.set({ subtitleTranslations: translations }, r));
    }
  } catch (e) {
    console.error("[intent-video] syncSubtitleTranslations failed:", e.message);
  }
}

function normalizeTranslationEntries(value) {
  const entries = Array.isArray(value) ? value : value?.entries;
  return Array.isArray(entries) ? entries.filter((entry) => entry?.translation) : [];
}

function markPage() {
  if (isYouTubeWatchPage()) {
    document.documentElement.classList.add("intent-youtube-watch");
  }
  if (isBilibiliWatchPage()) {
    document.documentElement.classList.add("intent-bilibili-watch");
  }
}

function hideDistractions() {
  const focus = document.querySelector("[data-intent-video-focus='true']");
  for (const selector of selectorsForHost()) {
    for (const node of document.querySelectorAll(selector)) {
      if (focus && (node === focus || node.contains(focus))) continue;
      node.setAttribute("data-intent-video-hidden", "true");
    }
  }
}

function selectorsForHost() {
  const host = location.hostname;
  if (host.includes("youtube.com")) {
    return [
      "#masthead",
      "ytd-masthead",
      "#secondary",
      "#comments",
      "ytd-watch-next-secondary-results-renderer",
      "ytd-merch-shelf-renderer",
      "ytd-reel-shelf-renderer",
      "ytd-rich-section-renderer",
      ".ytp-endscreen-content",
      "a[href^='/shorts']"
    ];
  }
  if (host.includes("bilibili.com")) {
    return [
      ".bili-header",
      "[class*='bili-header']",
      "[class*='BiliHeader']",
      ".international-header",
      ".mini-header",
      "[class*='left-entry']",
      "[class*='center-search']",
      "[class*='right-entry']",
      "[class*='nav-search']",
      "[class*='upload']",
      ".v-popular",
      ".ad-floor-exp",
      ".right-container",
      ".recommend-list-v1",
      ".video-page-card-small",
      ".reply-warp",
      ".reply-wrap",
      ".reply-container",
      "[class*='reply']",
      "[class*='Reply']",
      ".comment",
      ".comment-container",
      "#comment",
      "[class*='comment']",
      "[class*='Comment']",
      ".tag-panel",
      ".video-tag-container",
      "[class*='tag-panel']",
      ".fixed-sidenav-storage",
      ".video-toolbar-container",
      ".video-toolbar-left-main",
      "#viewbox_report",
      ".video-info-container",
      "[class*='video-info']",
      "[class*='VideoInfo']",
      ".video-desc-container",
      "[class*='video-desc']",
      "[class*='VideoDesc']",
      ".desc-info",
      "[class*='desc-info']",
      ".up-panel-container",
      "[class*='up-panel']",
      ".members-info-container",
      ".left-container-under-player",
      "[class*='left-container-under-player']",
      ".activity-m-v1",
      ".bili-dyn-list",
      ".bpx-player-ending-panel",
      ".ad-report"
    ];
  }
  return [];
}

function focusYouTubeWatch() {
  if (!isYouTubeWatchPage()) return;
  markPage();
  updateWatchStageSize();
  window.scrollTo(0, 0);
  const player =
    document.querySelector("#movie_player") ||
    document.querySelector(".html5-video-player");
  const frame =
    document.querySelector("#player") ||
    document.querySelector("ytd-player") ||
    player;
  if (!player || !frame) return;

  const root =
    frame.closest("#primary-inner") ||
    frame.closest("#primary") ||
    frame.closest("ytd-watch-flexy") ||
    frame.parentElement;

  frame.setAttribute("data-intent-video-focus", "true");
  frame.setAttribute("data-intent-video-stage", "true");
  player.setAttribute("data-intent-video-player", "true");
  revealFocusPath(frame);
  isolatePlayer(root, frame);
  nudgePlayerResize();
}

function focusBilibiliWatch() {
  if (!isBilibiliWatchPage()) return;
  markPage();
  enhanceBilibiliStackedSubtitles();
  updateWatchStageSize();
  window.scrollTo(0, 0);
  const player =
    document.querySelector("#bilibili-player") ||
    document.querySelector(".bpx-player-container");
  if (!player) return;

  const frame = player.closest(".player-wrap") || player;
  const root =
    frame.closest(".left-container") ||
    frame.closest(".video-container-v1") ||
    frame.closest(".video-container") ||
    frame.parentElement;

  frame.setAttribute("data-intent-video-focus", "true");
  frame.setAttribute("data-intent-video-stage", "true");
  player.setAttribute("data-intent-video-player", "true");
  document.querySelector(".bpx-player-container")?.setAttribute("data-intent-video-player", "true");
  revealFocusPath(frame);
  isolatePlayer(root, frame);
  nudgePlayerResize();
}

function enhanceBilibiliStackedSubtitles() {
  if (!isBilibiliWatchPage()) return;
  refreshBilibiliSubtitleMetadata();

  if (bilibiliSubtitleState.overlayActive) {
    updateBilibiliSubtitleOverlay();
    return;
  }

  if (bilibiliSubtitleState.englishSubtitleAvailable && bilibiliSubtitleState.chineseJson && bilibiliSubtitleState.englishJson) {
    startBilibiliSubtitleOverlay();
    document.documentElement.dataset.intentBilibiliSubtitles = "ready";
    document.documentElement.dataset.intentBilibiliSubtitleSource = "custom-overlay";
    return;
  }

  if (!document.documentElement.dataset.intentBilibiliSubtitles ||
      document.documentElement.dataset.intentBilibiliSubtitles === "ready") {
    document.documentElement.dataset.intentBilibiliSubtitles = bilibiliSubtitleState.subtitleAvailable ? "waiting" : "checking";
  }
}

function refreshBilibiliSubtitleMetadata() {
  const bvid = currentBilibiliBvid();
  if (!bvid) return;
  if (bilibiliSubtitleState.bvid !== bvid) {
    bilibiliSubtitleState.bvid = bvid;
    bilibiliSubtitleState.metadataPromise = null;
    bilibiliSubtitleState.subtitleAvailable = false;
    bilibiliSubtitleState.englishSubtitleAvailable = false;
    bilibiliSubtitleState.subtitleTracks = [];
    bilibiliSubtitleState.chineseJson = null;
    bilibiliSubtitleState.englishJson = null;
    bilibiliSubtitleState.bilingualSingleTrack = false;
    bilibiliSubtitleState.overlayActive = false;
    if (bilibiliSubtitleState.overlayElement) {
      bilibiliSubtitleState.overlayElement.remove();
      bilibiliSubtitleState.overlayElement = null;
    }
    document.documentElement.dataset.intentBilibiliSubtitles = "checking";
  }
  if (bilibiliSubtitleState.metadataPromise) return;
  bilibiliSubtitleState.metadataPromise = (async () => {
    try {
      let allTracks;
      try {
        const serverData = await fetchJsonViaBackground(`${APP}/api/bilibili/subtitle-tracks?bvid=${encodeURIComponent(bvid)}`);
        allTracks = Array.isArray(serverData?.tracks) ? serverData.tracks : [];
      } catch (e) {
        console.error("[intent-video] server subtitle-tracks failed:", e.message || e);
      }
      if (!allTracks?.length) {
        const payload = await fetchFromPage(`https://api.bilibili.com/x/player/v2?bvid=${encodeURIComponent(bvid)}${await bilibiliCidParam(bvid)}`, "application/json");
        const tracks = Array.isArray(payload?.data?.subtitle?.subtitles) ? payload.data.subtitle.subtitles : [];
        const fallback = Array.isArray(payload?.data?.subtitle?.list) ? payload.data.subtitle.list : [];
        allTracks = tracks.length ? tracks : fallback;
      }
      bilibiliSubtitleState.subtitleTracks = allTracks;
      bilibiliSubtitleState.subtitleAvailable = allTracks.length > 0;
      const cachedTranslation = await cachedBilibiliTranslationEntries(bvid);
      if (!bilibiliSubtitleState.subtitleAvailable && cachedTranslation.length) {
        bilibiliSubtitleState.chineseJson = cachedTranslation.map((e) => ({
          from: e.from,
          to: e.to,
          content: e.content
        }));
        bilibiliSubtitleState.englishJson = cachedTranslation.map((e) => ({
          from: e.from,
          to: e.to,
          content: e.translation
        }));
        bilibiliSubtitleState.englishSubtitleAvailable = true;
        bilibiliSubtitleState.bilingualSingleTrack = false;
        document.documentElement.dataset.intentBilibiliSubtitles = "waiting";
        return;
      }
      const englishTracks = allTracks.filter(isEnglishCapableBilibiliSubtitleTrack);
      const chineseTracks = allTracks.filter((t) => /zh|中文|Chinese/i.test(`${t.lan || ""} ${t.lan_doc || ""}`));
      const bilingualTracks = allTracks.filter((t) => /双语|bilingual|中英|英中/i.test(`${t.lan || ""} ${t.lan_doc || ""}`));
      bilibiliSubtitleState.englishSubtitleAvailable = englishTracks.length > 0 || bilingualTracks.length > 0;
      if (!bilibiliSubtitleState.subtitleAvailable) {
        document.documentElement.dataset.intentBilibiliSubtitles = "missing";
        return;
      }
      if (!bilibiliSubtitleState.englishSubtitleAvailable) {
        document.documentElement.dataset.intentBilibiliSubtitles = "translating";
        try {
          let cached = cachedTranslation;
          let cnBody = null;
          const chineseTrackWithUrl = chineseTracks.find((t) => t.subtitle_url || t.url) ||
            allTracks.find((t) => (t.subtitle_url || t.url) && !isEnglishCapableBilibiliSubtitleTrack(t));

          if (!cached?.length) {
            document.documentElement.dataset.intentBilibiliSubtitles = "missing-translation";
            return;
          }

          if (!cnBody && chineseTrackWithUrl) {
            cnBody = await downloadChineseSubtitleBody(chineseTrackWithUrl).catch(() => null);
          }

          bilibiliSubtitleState.chineseJson = cnBody || cached.map((e) => ({
            from: e.from,
            to: e.to,
            content: e.content
          }));
          bilibiliSubtitleState.englishJson = cached.map((e) => ({
            from: e.from,
            to: e.to,
            content: e.translation
          }));
          bilibiliSubtitleState.englishSubtitleAvailable = true;
          bilibiliSubtitleState.bilingualSingleTrack = false;
          document.documentElement.dataset.intentBilibiliSubtitles = "waiting";
          return;
        } catch (e) {
          console.error("[intent-video] TRANSLATE FAIL: exception during translation for bvid=%s:", bvid, e);
        }
        document.documentElement.dataset.intentBilibiliSubtitles = "missing-english";
        return;
      }
      const englishTrack = bilingualTracks[0] || englishTracks[0];
      const chineseTrack = chineseTracks[0] || allTracks.find((t) => t !== englishTrack) || allTracks[0];
      const tracksWithUrl = allTracks.filter((t) => t.subtitle_url || t.url);
      if (tracksWithUrl.length < allTracks.length && allTracks.length > 0) {
        try {
          const retry = await fetchFromPage(`https://api.bilibili.com/x/player/v2?bvid=${encodeURIComponent(bvid)}${await bilibiliCidParam(bvid)}`);
          const retryTracks = retry?.data?.subtitle?.subtitles || retry?.data?.subtitle?.list || [];
          for (const t of retryTracks) {
            const match = allTracks.find((o) => (o.lan || o.language) === (t.lan || t.language));
            if (match && (t.subtitle_url || t.url) && !(match.subtitle_url || match.url)) {
              match.subtitle_url = t.subtitle_url || t.url;
            }
          }
        } catch {}
      }
      const [engData, cnData] = await Promise.all([
        englishTrack ? fetchSubtitleJson(englishTrack).catch(() => null) : Promise.resolve(null),
        chineseTrack && chineseTrack !== englishTrack ? fetchSubtitleJson(chineseTrack).catch(() => null) : Promise.resolve(null)
      ]);
      if (!engData) {
        const hasEmptyUrl = englishTrack && !(englishTrack.subtitle_url || englishTrack.url);
        if (hasEmptyUrl) {
          document.documentElement.dataset.intentBilibiliSubtitles = "waiting-english-url";
          bilibiliSubtitleState.metadataPromise = null;
          setTimeout(() => { bilibiliSubtitleState.metadataPromise = null; }, 30000);
        } else {
          document.documentElement.dataset.intentBilibiliSubtitles = "missing-english";
        }
        return;
      }
      if (englishTrack === chineseTrack || !cnData) {
        bilibiliSubtitleState.englishJson = engData;
        bilibiliSubtitleState.chineseJson = engData;
        bilibiliSubtitleState.bilingualSingleTrack = true;
      } else {
        bilibiliSubtitleState.englishJson = engData;
        bilibiliSubtitleState.chineseJson = cnData;
        bilibiliSubtitleState.bilingualSingleTrack = false;
      }
      document.documentElement.dataset.intentBilibiliSubtitles = "waiting";
    } catch {
      document.documentElement.dataset.intentBilibiliSubtitles = "error";
    }
  })();
}

async function cachedBilibiliTranslationEntries(bvid) {
  let cached = await new Promise((resolve) => {
    chrome.storage.local.get("subtitleTranslations", (result) => {
      resolve(normalizeTranslationEntries(result.subtitleTranslations?.[bvid]));
    });
  });
  if (!cached?.length) {
    try {
      cached = normalizeTranslationEntries(await fetchJsonViaBackground(`${APP}/api/translated-subtitles?bvid=${encodeURIComponent(bvid)}`));
    } catch {}
  }
  return cached || [];
}

async function fetchSubtitleJson(track) {
  const url = track?.subtitle_url || track?.url || "";
  if (!url) return null;
  const fullUrl = url.startsWith("//") ? `https:${url}` : url;
  const payload = await fetchJsonViaBackground(fullUrl);
  return Array.isArray(payload?.body) ? payload.body : null;
}

async function downloadChineseSubtitleBody(track) {
  const cnTrackUrl = track?.subtitle_url || track?.url || "";
  if (!cnTrackUrl) return null;
  const cnFullUrl = cnTrackUrl.startsWith("//") ? `https:${cnTrackUrl}` : cnTrackUrl;
  try {
    const cnPayload = await fetchFromPage(cnFullUrl, "application/json");
    if (Array.isArray(cnPayload?.body)) return cnPayload.body;
  } catch {}
  const proxied = await fetchJsonViaBackground(`${APP}/api/bilibili/subtitle-json?url=${encodeURIComponent(cnTrackUrl)}`);
  return Array.isArray(proxied?.body) ? proxied.body : null;
}

function isEnglishCapableBilibiliSubtitleTrack(track) {
  const language = normalizeCaptionText(track?.lan || track?.language || "").toLocaleLowerCase().normalize("NFKC");
  const label = normalizeCaptionText(track?.lan_doc || track?.label || track?.name || "").toLocaleLowerCase().normalize("NFKC");
  const haystack = `${language} ${label}`;
  return /\ben(-|_|$|\b)/.test(language) ||
    /\beng(lish)?\b/.test(haystack) ||
    /english|英文|英语|中英|英中|双语|雙語|bilingual/.test(haystack);
}

function currentBilibiliBvid() {
  const match = location.pathname.match(/\/video\/(BV[1-9A-Za-z]+)/i);
  return match?.[1] || "";
}

async function fetchFromPage(url, accept) {
  const headers = { accept: accept || "application/json" };
  if (url.includes("bilibili.com")) headers.referer = "https://www.bilibili.com/";
  const res = await fetch(url, { credentials: "include", headers });
  if (!res.ok) throw new Error(`Page fetch HTTP ${res.status}`);
  return res.json();
}

async function bilibiliCidParam(bvid) {
  try {
    const data = await fetchFromPage(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`);
    const cid = data?.data?.cid;
    return cid ? `&cid=${cid}` : "";
  } catch {
    return "";
  }
}

async function fetchJsonViaBackground(url, options = {}) {
  const response = await new Promise((resolve, reject) => {
    if (!globalThis.chrome?.runtime?.sendMessage) {
      reject(new Error("Extension runtime unavailable"));
      return;
    }
    chrome.runtime.sendMessage({
      type: "intent:bgFetch",
      url,
      accept: "application/json",
      method: options.method,
      body: options.body,
      contentType: options.contentType
    }, (message) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message || "Background fetch failed"));
        return;
      }
      resolve(message);
    });
  });
  if (!response?.ok) throw new Error(response?.error || `HTTP ${response?.status || 0}`);
  return JSON.parse(response.text || "null");
}

function normalizeCaptionText(text) {
  return String(text || "").replace(/\r/g, "").split("\n").map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n").trim();
}

function containsCjkText(text) {
  return /[\u3400-\u9fff]/.test(String(text || ""));
}

function containsLatinWord(text) {
  return /\b[A-Za-z][A-Za-z'-]{2,}\b/.test(String(text || ""));
}

function detectVisibleStackedBilibiliSubtitles() {
  const overlay = document.getElementById("intent-video-subtitle-overlay");
  if (!overlay) return null;
  const lines = [...overlay.querySelectorAll("div")]
    .map((node) => normalizeCaptionText(node.textContent || ""))
    .filter(Boolean);
  const source = lines.find(containsCjkText) || "";
  const english = lines.find((line) => containsLatinWord(line) && line !== source) || "";
  return source && english ? { source, english } : null;
}

function startBilibiliSubtitleOverlay() {
  const video = document.querySelector("video");
  if (!video) return;

  const container = video.closest(".bpx-player-container, #bilibili-player, .player-wrap") || video.parentElement;
  if (!container) return;

  container.style.position = "relative";

  const overlay = document.createElement("div");
  overlay.id = "intent-video-subtitle-overlay";
  overlay.style.cssText = "position:absolute;bottom:48px;left:50%;transform:translateX(-50%);z-index:100;pointer-events:none;text-align:center;max-width:90%;";
  container.appendChild(overlay);
  bilibiliSubtitleState.overlayElement = overlay;
  bilibiliSubtitleState.overlayActive = true;

  video.addEventListener("timeupdate", updateBilibiliSubtitleOverlay);
  video.addEventListener("pause", updateBilibiliSubtitleOverlay);
  video.addEventListener("play", updateBilibiliSubtitleOverlay);
  updateBilibiliSubtitleOverlay();
}

function updateBilibiliSubtitleOverlay() {
  const overlay = bilibiliSubtitleState.overlayElement;
  if (!overlay) return;
  const video = document.querySelector("video");
  if (!video || video.paused) {
    if (video?.paused) overlay.innerHTML = "";
    return;
  }
  const time = video.currentTime;
  if (bilibiliSubtitleState.bilingualSingleTrack) {
    const entry = findSubtitleEntryAt(bilibiliSubtitleState.chineseJson, time);
    if (!entry) { overlay.innerHTML = ""; return; }
    const parts = splitBilingualEntry(entry.content || "");
    let html = "";
    if (parts.cjk) html += subtitleDivHtml(parts.cjk, 16);
    if (parts.latin) html += subtitleDivHtml(parts.latin, 14);
    if (parts.rest) html += subtitleDivHtml(parts.rest, 14);
    overlay.innerHTML = html;
  } else {
    const cn = findSubtitleAt(bilibiliSubtitleState.chineseJson, time);
    const en = findSubtitleAt(bilibiliSubtitleState.englishJson, time);
    let html = "";
    if (cn) html += subtitleDivHtml(cn, 16);
    if (en) html += subtitleDivHtml(en, 14);
    overlay.innerHTML = html;
  }
}

function subtitleDivHtml(text, fontSize) {
  return `<div style="color:#fff;background:rgba(0,0,0,0.75);padding:4px 12px;border-radius:4px;font-size:${fontSize}px;line-height:1.4;margin-bottom:4px;text-shadow:1px 1px 2px rgba(0,0,0,0.8)">${escapeHtml(text)}</div>`;
}

function splitBilingualEntry(text) {
  const lines = String(text || "").split(/\n|\\n/).map((l) => l.trim()).filter(Boolean);
  let cjk = "";
  let latin = "";
  const rest = [];
  for (const line of lines) {
    if (!cjk && /[\u3400-\u9fff]/.test(line) && !/\b[A-Za-z][A-Za-z'-]{2,}\b/.test(line.replace(/[\u3400-\u9fff]/g, ""))) {
      cjk = line;
    } else if (!latin && /\b[A-Za-z][A-Za-z'-]{2,}\b/.test(line) && !/[\u3400-\u9fff]/.test(line)) {
      latin = line;
    } else {
      rest.push(line);
    }
  }
  return { cjk, latin, rest: rest.join(" ") || null };
}

function findSubtitleAt(subtitleJson, time) {
  if (!Array.isArray(subtitleJson)) return null;
  const entry = subtitleJson.find((item) => time >= (item.from || 0) && time <= (item.to || 0));
  return entry?.content || null;
}

function findSubtitleEntryAt(subtitleJson, time) {
  if (!Array.isArray(subtitleJson)) return null;
  return subtitleJson.find((item) => time >= (item.from || 0) && time <= (item.to || 0)) || null;
}

function escapeHtml(text) {
  return String(text || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function revealFocusPath(node) {
  let current = node;
  while (current) {
    current.removeAttribute("data-intent-video-hidden");
    current = current.parentElement;
  }
}

function isolatePlayer(root, frame) {
  if (!root || !frame) return;
  root.setAttribute("data-intent-video-root", "true");
  let current = frame;
  while (current && current !== root && current.parentElement) {
    for (const sibling of current.parentElement.children) {
      if (sibling !== current && !sibling.contains(current)) {
        sibling.setAttribute("data-intent-video-hidden", "true");
      }
    }
    current = current.parentElement;
  }
  for (const child of root.children) {
    if (child !== current && child !== frame && !child.contains(frame)) {
      child.setAttribute("data-intent-video-hidden", "true");
    }
  }
}

function isBilibiliWatchPage() {
  return location.hostname.includes("bilibili.com") && /\/video\/BV/i.test(location.pathname);
}

function isYouTubeWatchPage() {
  return location.hostname.includes("youtube.com") && location.pathname === "/watch" && new URLSearchParams(location.search).has("v");
}

function nudgePlayerResize() {
  const now = Date.now();
  if (now - lastPlayerResizeAt < 1000) return;
  lastPlayerResizeAt = now;
  requestAnimationFrame(() => {
    window.dispatchEvent(new Event("resize"));
  });
}

function updateWatchStageSize() {
  const viewport = window.visualViewport || window;
  const width = Number(viewport.width || window.innerWidth || document.documentElement.clientWidth || 0);
  const height = Number(viewport.height || window.innerHeight || document.documentElement.clientHeight || 0);
  if (!width || !height) return;
  document.documentElement.style.setProperty("--intent-video-stage-width", `${width}px`);
  document.documentElement.style.setProperty("--intent-video-stage-height", `${height}px`);
}

async function detectAndReportAuth() {
  const auth = detectAuthState();
  if (!auth) return;
  const key = `${auth.platform}:${auth.status}`;
  if (key === lastAuthReport) return;
  lastAuthReport = key;
  try {
    await fetch(`${APP}/api/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(auth)
    });
    if (auth.status === "signedIn" && new URLSearchParams(location.search).get("intent_login_check") === "1") {
      location.href = APP;
    }
  } catch {
    lastAuthReport = "";
  }
}

function detectAuthState() {
  if (location.hostname.includes("youtube.com")) {
    if (hasVisibleNode("#avatar-btn, button#avatar-btn, ytd-topbar-menu-button-renderer #avatar, a[href*='accounts.google.com/SignOutOptions']")) {
      return { platform: "youtube", status: "signedIn" };
    }
    if (hasVisibleNode("a[href*='accounts.google.com/ServiceLogin'], ytd-button-renderer a[href*='ServiceLogin'], a[href*='/signin']")) {
      return { platform: "youtube", status: "signedOut" };
    }
  }
  if (location.hostname.includes("bilibili.com")) {
    if (hasVisibleNode(".header-avatar-wrap img, .bili-avatar img, [class*='avatar'] img, a[href*='account.bilibili.com']")) {
      return { platform: "bilibili", status: "signedIn" };
    }
    if (hasVisibleText(/登录|立即登录|log in|sign in/i) || hasVisibleNode("a[href*='passport.bilibili.com/login'], a[href*='/login']")) {
      return { platform: "bilibili", status: "signedOut" };
    }
  }
  return null;
}

function hasVisibleNode(selector) {
  return [...document.querySelectorAll(selector)].some(isVisible);
}

function hasVisibleText(pattern) {
  return [...document.querySelectorAll("a, button, span, div")]
    .some((node) => isVisible(node) && pattern.test(node.textContent || ""));
}

function isVisible(node) {
  const style = getComputedStyle(node);
  const rect = node.getBoundingClientRect();
  return style.display !== "none" &&
    style.visibility !== "hidden" &&
    Number(style.opacity || 1) > 0 &&
    rect.width > 0 &&
    rect.height > 0;
}

async function collectSuggestions() {
  if (!location.hostname.includes("bilibili.com")) return;
  const items = bilibiliSuggestions();
  if (!items.length) return;
  try {
    await fetch(`${APP}/api/collect-bilibili`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items })
    });
  } catch {
    // The extension must not break platform playback when the local app is down.
  }
}

function bilibiliSuggestions() {
  return [...document.querySelectorAll("a[href*='/video/'], .bili-video-card a, .video-card a, .feed-card a")]
    .map((anchor) => {
      const card = anchor.closest(".bili-video-card, .video-card, .feed-card") || anchor;
      const titleNode = card.querySelector(".bili-video-card__info--tit, .video-card__info, .bili-video-card__info--title, [title]");
      return {
        platform: "bilibili",
        title: cleanBilibiliTitle(titleNode?.textContent || anchor.title || anchor.textContent || ""),
        uploader: card.querySelector(".bili-video-card__info--author, .up-name, .name")?.textContent?.trim() || "",
        thumbnail: anchor.querySelector("img")?.src || card.querySelector("img")?.src || "",
        url: new URL(anchor.getAttribute("href") || "", location.origin).href
      };
    })
    .filter((item) => item.title && /\/video\/BV/i.test(new URL(item.url).pathname))
    .filter(uniqueByUrl())
    .slice(0, 20);
}

function cleanBilibiliTitle(text) {
  return String(text)
    .replace(/添加至稍后再看/g, "")
    .replace(/\d+(\.\d+)?万?/g, "")
    .replace(/\d{1,2}:\d{2}(:\d{2})?/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueByUrl() {
  const seen = new Set();
  return (item) => {
    if (seen.has(item.url)) return false;
    seen.add(item.url);
    return true;
  };
}
