const APP = "http://127.0.0.1:47231";
const FETCH_HOSTS = new Set(["api.bilibili.com", "127.0.0.1", "localhost", "aisubtitle.hdslb.com"]);

chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId !== 0) return;
  route(details);
}, {
  url: [
    { hostContains: "youtube.com" },
    { hostEquals: "youtu.be" },
    { hostContains: "bilibili.com" },
    { hostEquals: "accounts.google.com" },
    { hostEquals: "myaccount.google.com" },
    { hostEquals: "passport.bilibili.com" },
    { hostEquals: "account.bilibili.com" }
  ]
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message) return false;
  if (message.type === "intent:relayCookies") {
    sendBilibiliCookies();
    sendResponse({ ok: true });
    return false;
  }
  if (message.type !== "intent:bgFetch") return false;
  const url = String(message.url || "");
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    sendResponse({ ok: false, status: 0, error: "Invalid URL" });
    return true;
  }
  if (!isAllowedFetchHost(parsed.hostname)) {
    sendResponse({ ok: false, status: 0, error: "Fetch host is not allowed" });
    return true;
  }
  const fetchOpts = {
    method: message.method || "GET",
    credentials: "include",
    headers: {
      accept: message.accept || "*/*"
    }
  };
  if (message.body) {
    fetchOpts.headers["content-type"] = message.contentType || "application/json";
    fetchOpts.body = typeof message.body === "string" ? message.body : JSON.stringify(message.body);
  }
  fetch(parsed.href, fetchOpts)
    .then(async (response) => {
      sendResponse({
        ok: response.ok,
        status: response.status,
        text: await response.text()
      });
    })
    .catch((error) => {
      console.error("[intent-video] bgFetch FAILED:", url.substring(0, 60), error.message || String(error));
      sendResponse({ ok: false, status: 0, error: error.message || String(error) });
    });
  return true;
});

async function route(details) {
  const appAvailable = await isAppAvailable();
  const decision = appAvailable ? await navigationDecision(details.url) : { action: classify(details.url) };
  if (decision.action === "ignore" || decision.action === "allow") return;
  const target =
    appAvailable && decision.action === "redirect"
      ? `${APP}/?url=${encodeURIComponent(details.url)}`
      : appAvailable
        ? `${APP}/?blocked=${encodeURIComponent(details.url)}`
        : chrome.runtime.getURL(`block.html?url=${encodeURIComponent(details.url)}`);

  chrome.tabs.update(details.tabId, { url: target });
}

async function navigationDecision(url) {
  try {
    const res = await fetch(`${APP}/api/navigation?url=${encodeURIComponent(url)}`, { cache: "no-store" });
    if (!res.ok) return { action: classify(url) };
    return await res.json();
  } catch {
    return { action: classify(url) };
  }
}

async function isAppAvailable() {
  try {
    const res = await fetch(`${APP}/api/health`, { cache: "no-store" });
    return res.ok;
  } catch {
    return false;
  }
}

function classify(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    return "ignore";
  }
  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();
  if (isAuthUrl(host, path)) return "ignore";

  if (host === "youtu.be") return "redirect";
  if (host.endsWith("youtube.com")) {
    if (path === "/feed/history") return "ignore";
    if (path === "/watch") return "redirect";
    if (path.startsWith("/shorts/")) return "redirect";
    return "block";
  }
  if (host.endsWith("bilibili.com")) {
    if (path === "/account/history") return "ignore";
    if (path.startsWith("/video/")) return "redirect";
    return "block";
  }
  return "ignore";
}

function isAuthUrl(host, path) {
  if (["accounts.google.com", "myaccount.google.com"].includes(host)) return true;
  if (["passport.bilibili.com", "account.bilibili.com"].includes(host)) return true;
  if (host.endsWith("youtube.com") && (
    path.startsWith("/signin") ||
    path.startsWith("/oops") ||
    path.startsWith("/account") ||
    path.startsWith("/premium") ||
    path.startsWith("/paid_memberships")
  )) return true;
  if (host.endsWith("bilibili.com") && (
    path.startsWith("/login") ||
    path.startsWith("/account") ||
    path.startsWith("/passport")
  )) return true;
  return false;
}

function isAllowedFetchHost(host) {
  return FETCH_HOSTS.has(host) || host.endsWith(".hdslb.com");
}

function sendBilibiliCookies() {
  const domains = ["bilibili.com", ".bilibili.com", "www.bilibili.com", "bilibili.cn", ".bilibili.cn"];
  let allCookies = [];
  let pending = domains.length;
  for (const domain of domains) {
    chrome.cookies.getAll({ domain }, (cookies) => {
      if (chrome.runtime.lastError) {
        console.error("[intent-video] cookie error:", chrome.runtime.lastError);
      }
      if (cookies && cookies.length) allCookies.push(...cookies);
      pending--;
      if (pending > 0) return;
      if (!allCookies.length) return;
      const seen = new Set();
      const header = allCookies
        .filter((c) => {
          const key = `${c.name}@${c.domain}@${c.path}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .map((c) => `${c.name}=${c.value}`)
        .join("; ");
      if (!header) return;
      fetch(`${APP}/api/bilibili-cookies`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cookie: header })
      })
        .catch(() => {
          // The local app is often offline while the browser extension is still loaded.
        });
    });
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("bilibili-cookies", { periodInMinutes: 2 });
  sendBilibiliCookies();
});
chrome.runtime.onStartup.addListener(() => sendBilibiliCookies());
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "bilibili-cookies") sendBilibiliCookies();
});
sendBilibiliCookies();
