const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"]);
const BILIBILI_HOSTS = new Set(["bilibili.com", "www.bilibili.com", "m.bilibili.com"]);
const GOOGLE_AUTH_HOSTS = new Set(["accounts.google.com", "myaccount.google.com"]);
const BILIBILI_AUTH_HOSTS = new Set(["passport.bilibili.com", "account.bilibili.com"]);

export function parseVideoUrl(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase();
  if (isYouTubeHost(host)) {
    if (host === "youtu.be") {
      const id = url.pathname.split("/").filter(Boolean)[0];
      return id ? { platform: "youtube", id, canonicalUrl: `https://www.youtube.com/watch?v=${id}` } : null;
    }
    if (url.pathname === "/watch" && url.searchParams.get("v")) {
      const id = url.searchParams.get("v");
      return { platform: "youtube", id, canonicalUrl: `https://www.youtube.com/watch?v=${id}` };
    }
    if (url.pathname.startsWith("/shorts/")) {
      const id = url.pathname.split("/").filter(Boolean)[1];
      return id ? { platform: "youtube", id, canonicalUrl: `https://www.youtube.com/shorts/${id}`, isShort: true } : null;
    }
  }

  if (isBilibiliHost(host)) {
    const match = url.pathname.match(/\/video\/([^/?#]+)/);
    if (match) {
      return { platform: "bilibili", id: match[1], canonicalUrl: `https://www.bilibili.com/video/${match[1]}` };
    }
  }

  return null;
}

export function classifyBrowserNavigation(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    return { action: "ignore" };
  }
  const parsed = parseVideoUrl(input);
  if (parsed) return { action: "redirect", video: parsed };

  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();
  if (isAuthUrl(host, path)) return { action: "ignore" };
  if (isYouTubeHost(host)) {
    if (path === "/feed/history") return { action: "ignore" };
    return { action: "block", platform: "youtube" };
  }
  if (isBilibiliHost(host)) {
    if (path === "/account/history") return { action: "ignore" };
    return { action: "block", platform: "bilibili" };
  }
  return { action: "ignore" };
}

function isYouTubeHost(host) {
  return host === "youtu.be" || YOUTUBE_HOSTS.has(host) || host.endsWith(".youtube.com");
}

function isBilibiliHost(host) {
  return BILIBILI_HOSTS.has(host) || host.endsWith(".bilibili.com");
}

function isAuthUrl(host, path) {
  if (GOOGLE_AUTH_HOSTS.has(host)) return true;
  if (BILIBILI_AUTH_HOSTS.has(host)) return true;
  if (YOUTUBE_HOSTS.has(host) && (
    path.startsWith("/signin") ||
    path.startsWith("/oops") ||
    path.startsWith("/account") ||
    path.startsWith("/premium") ||
    path.startsWith("/paid_memberships")
  )) return true;
  if (BILIBILI_HOSTS.has(host) && (
    path.startsWith("/login") ||
    path.startsWith("/account") ||
    path.startsWith("/passport")
  )) return true;
  return false;
}

export function isAllowedDecision(value) {
  return ["allow", "block", "ask"].includes(value);
}
