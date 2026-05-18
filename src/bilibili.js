const THUMBNAIL_HOSTS = new Set([
  "i0.hdslb.com",
  "i1.hdslb.com",
  "i2.hdslb.com",
  "s1.hdslb.com"
]);

export function normalizeBilibiliThumbnailUrl(rawUrl) {
  if (!rawUrl) return "";
  const withProtocol = String(rawUrl).startsWith("//") ? `https:${rawUrl}` : String(rawUrl);
  try {
    const url = new URL(withProtocol);
    if (url.protocol === "http:") url.protocol = "https:";
    if (!THUMBNAIL_HOSTS.has(url.hostname.toLowerCase())) return "";
    return url.href;
  } catch {
    return "";
  }
}

export function thumbnailProxyPath(rawUrl) {
  const normalized = normalizeBilibiliThumbnailUrl(rawUrl);
  return normalized ? `/api/bilibili/thumbnail?url=${encodeURIComponent(normalized)}` : "";
}

export async function proxyBilibiliThumbnail(rawUrl, res) {
  const normalized = normalizeBilibiliThumbnailUrl(rawUrl);
  if (!normalized) return false;

  const upstream = await fetch(normalized, {
    headers: {
      "user-agent": browserUserAgent(),
      referer: "https://www.bilibili.com/"
    }
  });
  if (!upstream.ok || !upstream.body) return false;

  res.writeHead(200, {
    "content-type": upstream.headers.get("content-type") || "image/jpeg",
    "cache-control": "public, max-age=86400"
  });
  for await (const chunk of upstream.body) res.write(chunk);
  res.end();
  return true;
}

function browserUserAgent() {
  return "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";
}
