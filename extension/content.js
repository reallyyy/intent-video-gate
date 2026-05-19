const APP = "http://127.0.0.1:47231";
let lastPlayerResizeAt = 0;
let lastAuthReport = "";
const bilibiliSubtitleState = {
  bvid: "",
  metadataPromise: null,
  subtitleAvailable: false,
  englishSubtitleAvailable: false,
  lastActivateAt: 0
};

updateWatchStageSize();
installPanel();
markPage();
detectAndReportAuth();
hideDistractions();
focusYouTubeWatch();
focusBilibiliWatch();
setInterval(detectAndReportAuth, 2000);
setInterval(hideDistractions, 1500);
setInterval(focusYouTubeWatch, 1500);
setInterval(focusBilibiliWatch, 1500);
setInterval(enhanceBilibiliStackedSubtitles, 700);
setTimeout(collectSuggestions, 1800);
setInterval(collectSuggestions, 15000);
window.addEventListener("resize", () => {
  updateWatchStageSize();
  nudgePlayerResize();
});
window.visualViewport?.addEventListener("resize", () => {
  updateWatchStageSize();
  nudgePlayerResize();
});

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

  const stacked = detectVisibleStackedBilibiliSubtitles();
  if (stacked) {
    document.documentElement.dataset.intentBilibiliSubtitles = "ready";
    document.documentElement.dataset.intentBilibiliSubtitleSource = stacked.source;
    return;
  }

  const activated = activateNativeBilibiliStackedSubtitles();
  if (activated) {
    document.documentElement.dataset.intentBilibiliSubtitles = "activating";
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
    document.documentElement.dataset.intentBilibiliSubtitles = "checking";
  }
  if (bilibiliSubtitleState.metadataPromise) return;
  bilibiliSubtitleState.metadataPromise = fetchJsonViaBackground(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`)
    .then((payload) => {
      const tracks = Array.isArray(payload?.data?.subtitle?.list) ? payload.data.subtitle.list : [];
      bilibiliSubtitleState.subtitleAvailable = tracks.length > 0;
      bilibiliSubtitleState.englishSubtitleAvailable = tracks.some(isEnglishCapableBilibiliSubtitleTrack);
      document.documentElement.dataset.intentBilibiliSubtitles = !tracks.length
        ? "missing"
        : bilibiliSubtitleState.englishSubtitleAvailable ? "waiting" : "missing-english";
    })
    .catch(() => {
      document.documentElement.dataset.intentBilibiliSubtitles = "error";
    });
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

async function fetchJsonViaBackground(url) {
  const response = await new Promise((resolve, reject) => {
    if (!globalThis.chrome?.runtime?.sendMessage) {
      reject(new Error("Extension runtime unavailable"));
      return;
    }
    chrome.runtime.sendMessage({ type: "intent:bgFetch", url, accept: "application/json" }, (message) => {
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

function activateNativeBilibiliStackedSubtitles() {
  const now = Date.now();
  if (now - bilibiliSubtitleState.lastActivateAt < 2500) return false;
  bilibiliSubtitleState.lastActivateAt = now;

  const subtitleControl = document.querySelector(".bpx-player-ctrl-subtitle");
  if (!subtitleControl) return false;

  dispatchUserLikeMouse(subtitleControl);

  if (closeBilibiliSubtitleOffSwitch()) return true;

  const selectedEnglish = clickBilibiliSubtitleOption(
    (text) => /English|英文|英语|中英|英中|双语|雙語|bilingual/i.test(text),
    ".bpx-player-ctrl-subtitle-major, .bpx-player-ctrl-subtitle-menu"
  );

  const selectedChinese = !selectedEnglish && clickBilibiliSubtitleOption(
    (text) => /中文|Chinese|简体|繁體/.test(text),
    ".bpx-player-ctrl-subtitle-major, .bpx-player-ctrl-subtitle-menu"
  );

  const enabledBilingual = enableBilibiliBilingualSwitch();

  return selectedEnglish || selectedChinese || enabledBilingual;
}

function clickBilibiliSubtitleOption(matchesText, scopeSelector) {
  const scopes = scopeSelector
    ? [...document.querySelectorAll(scopeSelector)]
    : [document];
  for (const scope of scopes) {
    const items = [...scope.querySelectorAll(".bpx-player-ctrl-subtitle-language-item, [class*='subtitle-language-item'], [class*='subtitle-item']")];
    const match = items.find((item) => matchesText(normalizeCaptionText(item.textContent || "")));
    if (!match) continue;
    dispatchUserLikeMouse(match);
    return true;
  }
  return false;
}

function enableBilibiliBilingualSwitch() {
  const controls = [
    ...document.querySelectorAll(".bpx-player-ctrl-subtitle-bilingual-above input, [aria-label='双语字幕'], .bpx-player-ctrl-subtitle-bilingual-above")
  ];
  for (const control of controls) {
    const wrapper = control.closest(".bpx-player-ctrl-subtitle-bilingual-above, .bui-switch") || control;
    const active = control.checked === true ||
      wrapper.classList.contains("bui-switch-checked") ||
      wrapper.classList.contains("bpx-state-active");
    if (active) return true;
    dispatchUserLikeMouse(control);
    if (control !== wrapper) dispatchUserLikeMouse(wrapper);
    return true;
  }
  return false;
}

function closeBilibiliSubtitleOffSwitch() {
  const off = [...document.querySelectorAll(".bpx-player-ctrl-subtitle-close-switch, .bpx-player-ctrl-subtitle-fake-switch")]
    .find((node) => /关闭/.test(node.textContent || "") && node.classList.contains("bpx-state-active"));
  if (!off) return false;
  dispatchUserLikeMouse(off);
  return true;
}

function dispatchUserLikeMouse(node) {
  if (!node) return;
  for (const type of ["mouseenter", "mouseover", "mousemove", "mousedown", "mouseup", "click"]) {
    node.dispatchEvent(new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      view: window,
      button: 0
    }));
  }
}

function detectVisibleStackedBilibiliSubtitles() {
  const major = visibleSubtitleText(".bili-subtitle-x-subtitle-panel-major-group, [class*='subtitle-panel-major']");
  const minor = visibleSubtitleText(".bili-subtitle-x-subtitle-panel-minor-group, [class*='subtitle-panel-minor']");
  if (isStackedSubtitlePair(major, minor)) return { source: "native-bilingual-groups" };

  for (const root of visibleSubtitleRoots()) {
    const lines = renderedSubtitleLines(root);
    if (linesContainStackedPair(lines)) return { source: "native-rendered-container" };
    if (nearbyLinesContainStackedPair(lines)) return { source: "native-rendered-nearby-lines" };
  }

  const groups = visibleSubtitleLeaves();
  for (let i = 0; i < groups.length; i += 1) {
    for (let j = 0; j < groups.length; j += 1) {
      if (i === j) continue;
      const first = groups[i];
      const second = groups[j];
      if (Math.abs(first.rect.left - second.rect.left) > Math.max(80, first.rect.width * 0.4)) continue;
      if (second.rect.top <= first.rect.top) continue;
      if (isStackedSubtitlePair(first.text, second.text)) return { source: "native-visible-lines" };
    }
  }
  return null;
}

function visibleSubtitleText(selector) {
  const node = [...document.querySelectorAll(selector)].find(isVisible);
  return node ? normalizeCaptionText(node.textContent || "") : "";
}

function visibleSubtitleLeaves() {
  const roots = visibleSubtitleRoots();
  const leaves = [];
  for (const root of roots) {
    const candidates = root.childElementCount
      ? [...root.querySelectorAll("*")].filter((node) => node.childElementCount === 0)
      : [root];
    for (const node of candidates) {
      if (!isVisible(node)) continue;
      const text = normalizeCaptionText(node.textContent || "");
      if (text.length < 2 || /^(字幕|关闭|开启|自动|设置|双语字幕)$/.test(text)) continue;
      leaves.push({ node, text, rect: node.getBoundingClientRect() });
    }
  }
  return leaves;
}

function isStackedSubtitlePair(first, second) {
  if (!first || !second || first === second) return false;
  return (containsCjkText(first) && containsLatinWord(second)) ||
    (containsLatinWord(first) && containsCjkText(second));
}

function visibleSubtitleRoots() {
  return [
    ...document.querySelectorAll(".bpx-player-subtitle-wrap, .bili-subtitle-x-subtitle-panel, .bilibili-player-video-subtitle, [data-intent-video-player='true']")
  ].filter(isVisible);
}

function renderedSubtitleLines(node) {
  return normalizeCaptionText(node.innerText || node.textContent || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length >= 2 && !/^(字幕|关闭|开启|自动|设置|双语字幕)$/.test(line));
}

function linesContainStackedPair(lines) {
  for (let i = 0; i < lines.length - 1; i += 1) {
    if (isStackedSubtitlePair(lines[i], lines[i + 1])) return true;
  }
  return false;
}

function nearbyLinesContainStackedPair(lines) {
  for (let i = 0; i < lines.length; i += 1) {
    for (let j = i + 1; j < Math.min(lines.length, i + 5); j += 1) {
      if (isStackedSubtitlePair(lines[i], lines[j])) return true;
    }
  }
  return false;
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
