import { parseVideoUrl } from "./rules.js";

const grants = new Map();

export function createGrant(rawUrl, ttlMs = 5 * 60 * 1000) {
  const canonicalUrl = canonicalize(rawUrl);
  if (!canonicalUrl) throw new Error("Cannot grant unsupported URL.");
  const grant = {
    url: canonicalUrl,
    expiresAt: Date.now() + ttlMs
  };
  grants.set(canonicalUrl, grant);
  return grant;
}

export function hasGrant(rawUrl) {
  const canonicalUrl = canonicalize(rawUrl);
  if (!canonicalUrl) return false;
  const grant = grants.get(canonicalUrl);
  if (!grant) return false;
  if (grant.expiresAt <= Date.now()) {
    grants.delete(canonicalUrl);
    return false;
  }
  return true;
}

export function listGrants() {
  sweepGrants();
  return [...grants.values()];
}

export function sweepGrants() {
  const now = Date.now();
  for (const [url, grant] of grants) {
    if (grant.expiresAt <= now) grants.delete(url);
  }
}

export function canonicalize(rawUrl) {
  const videoUrl = parseVideoUrl(rawUrl)?.canonicalUrl;
  if (videoUrl) return videoUrl;
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    if (["www.youtube.com", "youtube.com"].includes(host) && url.pathname === "/") return "https://www.youtube.com/";
    if (["www.bilibili.com", "bilibili.com"].includes(host) && url.pathname === "/") return "https://www.bilibili.com/";
  } catch {
    return null;
  }
  return null;
}
