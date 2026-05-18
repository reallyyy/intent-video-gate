const APP = "http://127.0.0.1:47231";

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
