import { appendFile, readFile, writeFile } from "node:fs/promises";
import { paths } from "./paths.js";
import { ensureDirs } from "./config.js";

export async function appendHistory(entry) {
  await ensureDirs();
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  await appendFile(paths.historyFile, line + "\n");
}

export async function readJsonl(file, limit = 100) {
  try {
    const raw = await readFile(file, "utf8");
    return raw
      .trim()
      .split("\n")
      .filter(Boolean)
      .slice(-limit)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

export function readHistory(limit = 100) {
  return readJsonl(paths.historyFile, limit);
}

export async function readCachedSuggestions() {
  try {
    const raw = await readFile(paths.cacheFile, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.suggestions) ? parsed.suggestions : [];
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

export async function writeCachedSuggestions(suggestions) {
  await ensureDirs();
  let current = {};
  try {
    current = JSON.parse(await readFile(paths.cacheFile, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  current.suggestions = suggestions;
  current.updatedAt = new Date().toISOString();
  await writeFile(paths.cacheFile, JSON.stringify(current, null, 2) + "\n");
}

export async function readCachedFeed() {
  try {
    const raw = await readFile(paths.cacheFile, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.feed) ? parsed.feed : [];
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

export async function writeCachedFeed(feed) {
  await ensureDirs();
  let current = {};
  try {
    current = JSON.parse(await readFile(paths.cacheFile, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  current.feed = feed;
  current.feedUpdatedAt = new Date().toISOString();
  await writeFile(paths.cacheFile, JSON.stringify(current, null, 2) + "\n");
}

export async function readFilter() {
  try {
    const raw = await readFile(paths.configFile, "utf8");
    return String(JSON.parse(raw).filter || "");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

export async function writeFilter(filter) {
  await ensureDirs();
  let current = {};
  try {
    current = JSON.parse(await readFile(paths.configFile, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  current.filter = String(filter || "");
  await writeFile(paths.configFile, JSON.stringify(current, null, 2) + "\n");
}

export async function readAuthState() {
  try {
    const raw = await readFile(paths.configFile, "utf8");
    return normalizeAuthState(JSON.parse(raw).auth);
  } catch (error) {
    if (error.code === "ENOENT") return defaultAuthState();
    throw error;
  }
}

export async function writeAuthState(platform, status) {
  const normalizedPlatform = String(platform || "").toLowerCase();
  const normalizedStatus = String(status || "");
  if (!["youtube", "bilibili"].includes(normalizedPlatform)) throw new Error("Unknown platform.");
  if (!["unknown", "signedIn", "signedOut"].includes(normalizedStatus)) throw new Error("Unknown auth status.");

  await ensureDirs();
  let current = {};
  try {
    current = JSON.parse(await readFile(paths.configFile, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  current.auth = normalizeAuthState(current.auth);
  current.auth[normalizedPlatform] = {
    status: normalizedStatus,
    updatedAt: new Date().toISOString()
  };
  await writeFile(paths.configFile, JSON.stringify(current, null, 2) + "\n");
  return current.auth;
}

function defaultAuthState() {
  return {
    youtube: { status: "unknown", updatedAt: null },
    bilibili: { status: "unknown", updatedAt: null }
  };
}

function normalizeAuthState(auth) {
  const current = defaultAuthState();
  for (const platform of Object.keys(current)) {
    if (["unknown", "signedIn", "signedOut"].includes(auth?.[platform]?.status)) {
      current[platform] = {
        status: auth[platform].status,
        updatedAt: auth[platform].updatedAt || null
      };
    }
  }
  return current;
}

export async function preferenceProfile(limit = 300) {
  const entries = await readHistory(limit);
  const profile = {
    preferChannels: [],
    blockChannels: [],
    moreLike: [],
    lessLike: []
  };
  for (const entry of entries) {
    if (entry.type !== "feedback") continue;
    const channel = entry.candidate?.uploader;
    if (entry.action === "block-channel" && channel) profile.blockChannels.push(channel);
    if (entry.action === "prefer-channel" && channel) profile.preferChannels.push(channel);
    if (entry.action === "more-like-this") profile.moreLike.push(summary(entry.candidate));
    if (entry.action === "less-like-this") profile.lessLike.push(summary(entry.candidate));
  }
  return {
    preferChannels: unique(profile.preferChannels).slice(-40),
    blockChannels: unique(profile.blockChannels).slice(-80),
    moreLike: profile.moreLike.filter(Boolean).slice(-40),
    lessLike: profile.lessLike.filter(Boolean).slice(-40)
  };
}

function unique(values) {
  return [...new Set(values.filter(Boolean).map(String))];
}

function summary(candidate) {
  if (!candidate) return null;
  return {
    platform: candidate.platform,
    title: candidate.title || candidate.gate?.safeTitle || "",
    uploader: candidate.uploader || ""
  };
}
