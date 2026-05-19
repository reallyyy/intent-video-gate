import { run } from "./process.js";
import { isAllowedDecision } from "./rules.js";

export async function classifyCandidates({ intent, candidates, config, preferences = {} }) {
  if (!intent || !intent.trim()) {
    return candidates.map((candidate) => blocked(candidate, "No active intent."));
  }
  if (!candidates.length) return [];

  const prompt = buildPrompt(intent, candidates, preferences);
  const primary = await callGemini(prompt, config.gemini.model, config);
  const parsed = parseGeminiResult(primary);
  if (parsed.ok) return alignDecisions(candidates, parsed.decisions);

  const fallback = await callGemini(prompt, config.gemini.fallbackModel, config);
  const fallbackParsed = parseGeminiResult(fallback);
  if (fallbackParsed.ok) return alignDecisions(candidates, fallbackParsed.decisions);

  return candidates.map((candidate) => blocked(candidate, `AI unavailable: ${fallbackParsed.error || parsed.error}`));
}

export async function generateBilibiliSearchQueries({ intent, blockKeywords = [], approved = [], rejectedBilibili = [], config }) {
  if (!intent || !intent.trim()) return [];
  const prompt = buildBilibiliSearchQueryPrompt({ intent, blockKeywords, approved, rejectedBilibili });
  const primary = await callGemini(prompt, config.gemini.model, config);
  const parsed = parseSearchQueryResult(primary);
  if (parsed.ok) return parsed.queries;

  const fallback = await callGemini(prompt, config.gemini.fallbackModel, config);
  const fallbackParsed = parseSearchQueryResult(fallback);
  return fallbackParsed.ok ? fallbackParsed.queries : [];
}

export async function refineFilterForVideo({ intent, video, messages, config }) {
  if (!intent || !intent.trim()) throw new Error("No active filter prompt.");
  if (!video?.id) throw new Error("Unknown video.");
  const compactMessages = Array.isArray(messages)
    ? messages.map((message) => ({
      role: message.role === "assistant" ? "assistant" : "user",
      content: String(message.content || "").trim().slice(0, 1600)
    })).filter((message) => message.content)
    : [];

  const prompt = buildFilterRefinementPrompt(intent, video, compactMessages);
  const primary = await callGemini(prompt, config.gemini.model, config);
  const parsed = parseFilterRefinementResult(primary);
  if (parsed.ok) return parsed;

  const fallback = await callGemini(prompt, config.gemini.fallbackModel, config);
  const fallbackParsed = parseFilterRefinementResult(fallback);
  if (fallbackParsed.ok) return fallbackParsed;

  throw new Error(fallbackParsed.error || parsed.error || "Gemini did not return a usable prompt update.");
}

export function buildPrompt(intent, candidates, preferences) {
  const compact = candidates.map((candidate) => ({
    id: candidate.id,
    platform: candidate.platform,
    title: candidate.title,
    uploader: candidate.uploader,
    durationSeconds: candidate.durationSeconds,
    url: candidate.url,
    description: candidate.description?.slice(0, 900) || ""
  }));
  return `You filter a mixed YouTube and Bilibili video feed.
The user's filter text is:
${intent}

Personal preference profile:
${JSON.stringify(preferences, null, 2)}

Allow useful platform recommendations that match or reasonably support the filter text.
Treat the user's filter text as the source of truth. If it explicitly allows a category, style, creator, platform, language, or music taste, evaluate that material against the user's stated constraints instead of applying a generic category veto.
Block videos that clearly violate the filter text or the personal preference profile. Do not invent extra blocked categories beyond the user's text, the preference profile, and local keyword blocks already removed before this prompt.
When uncertain, allow if the video is plausibly informative, educational, practical, technical, language-learning, news-analysis, documentary-like, or otherwise useful under the filter.

Return only valid JSON, no markdown, with this shape:
{"decisions":[{"id":"candidate id","decision":"allow|block|ask","confidence":0.0,"reason":"short reason","labels":["short"],"safe_title":"clean title"}]}

Candidates:
${JSON.stringify(compact, null, 2)}`;
}

export function buildBilibiliSearchQueryPrompt({ intent, blockKeywords = [], approved = [], rejectedBilibili = [] }) {
  const compactApproved = approved.slice(0, 16).map((item) => ({
    platform: item.platform,
    title: item.title || item.gate?.safeTitle || "",
    uploader: item.uploader || ""
  }));
  const compactRejected = rejectedBilibili.slice(0, 16).map((item) => ({
    title: item.title || "",
    uploader: item.uploader || "",
    reason: item.gate?.reason || ""
  }));
  return `Generate Bilibili search queries for a high-quality video recommendation system.
The user's filter text is:
${intent}

Local block keywords that must be avoided:
${JSON.stringify(blockKeywords, null, 2)}

Currently approved videos that represent useful taste signals:
${JSON.stringify(compactApproved, null, 2)}

Bilibili candidates that were rejected, to avoid repeating the same bad pool:
${JSON.stringify(compactRejected, null, 2)}

Return only valid JSON, no markdown, with this shape:
{"queries":["short search query"]}

Rules:
- Generate 3 to 6 concise Bilibili search queries.
- Prefer Chinese search terms when they would work better on Bilibili.
- Bilibili videos must have subtitle or CC tracks because the watch page shows stacked original + English subtitles.
- Favor subtitle-rich query terms such as CC字幕, 双语字幕, 中英字幕, 英文字幕, or topic-specific equivalents when they still match the user's filter.
- Search for high-signal educational, documentary, technical, music, culture, analysis, or practical content matching the user's filter.
- Do not include blocked keywords, low-effort entertainment, AI slop, reaction clips, gossip, gaming, or broad clickbait terms.`;
}

function buildFilterRefinementPrompt(intent, video, messages) {
  const compactVideo = {
    id: video.id,
    platform: video.platform,
    title: video.title,
    uploader: video.uploader,
    durationSeconds: video.durationSeconds,
    url: video.url,
    description: video.description?.slice(0, 1800) || "",
    channel: video.channel || video.uploader || "",
    categories: Array.isArray(video.categories) ? video.categories.slice(0, 8) : [],
    tags: Array.isArray(video.tags) ? video.tags.slice(0, 16) : [],
    viewCount: Number(video.viewCount || 0),
    uploadDate: video.uploadDate || ""
  };
  return `You help refine a user's video recommendation filter.
The user selected a video that should not be recommended in the future.

Current filter prompt:
${intent}

Selected video:
${JSON.stringify(compactVideo, null, 2)}

Conversation about why this video should be tuned out:
${JSON.stringify(messages, null, 2)}

If there is no conversation yet, infer the most likely reasons this video may not fit the current filter from the title, uploader, description, tags, categories, duration, and URL. Offer useful reason choices so the user can accept your analysis without chatting.
If the conversation includes a selected reason or extra detail, use it to refine your analysis.

Write a concise reply to the user, summarize relevant video details, and offer 3 to 5 clickable tune-out options.
Each option must include a short reason, one standalone blocking guidance line, and a complete replacement filter prompt tailored to that reason.
Preserve the user's original positive intent. Add only the minimum specific blocking guidance needed to avoid similar future recommendations. Do not make the filter hostile, overbroad, or unrelated to the current prompt.

Return only valid JSON, no markdown, with this shape:
{"reply":"short response to user","video_summary":"short factual summary of relevant details","suggested_options":[{"reason":"reason user can choose","blocking_guidance":"short standalone blocking guidance line","proposed_filter":"complete updated filter prompt for this reason"}],"proposed_filter":"best default complete updated filter prompt"}`;
}

async function callGemini(prompt, model, config) {
  const args = [
    "-p",
    prompt,
    "-m",
    model,
    "-y",
    "--skip-trust",
    "--output-format",
    "json"
  ];

  let last;
  const attempts = Math.max(1, config.gemini.retries ?? 1);
  for (let i = 0; i < attempts; i += 1) {
    last = await run(config.gemini.command, args, {
      timeoutMs: config.gemini.timeoutMs,
      maxBuffer: 4 * 1024 * 1024
    });
    if (last.ok && last.stdout.trim()) return last;
    await new Promise((resolve) => setTimeout(resolve, 1000 * (i + 1)));
  }
  return last;
}

function parseOuterResponse(result) {
  if (!result?.ok) return { ok: false, error: result?.stderr || result?.error || "gemini failed" };
  let outer;
  try {
    outer = JSON.parse(result.stdout);
  } catch {
    return { ok: false, error: "gemini returned invalid outer JSON" };
  }
  const text = outer.response;
  if (typeof text !== "string") return { ok: false, error: "gemini response field missing" };
  const cleaned = text.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
  return { ok: true, text: cleaned };
}

export function parseGeminiResult(result) {
  const outer = parseOuterResponse(result);
  if (!outer.ok) return outer;
  let inner;
  try {
    inner = JSON.parse(outer.text);
  } catch {
    return { ok: false, error: "gemini response was not valid decision JSON" };
  }
  if (!Array.isArray(inner.decisions)) return { ok: false, error: "decisions array missing" };
  return { ok: true, decisions: inner.decisions };
}

export function parseSearchQueryResult(result) {
  const outer = parseOuterResponse(result);
  if (!outer.ok) return outer;
  let inner;
  try {
    inner = JSON.parse(outer.text);
  } catch {
    return { ok: false, error: "gemini response was not valid search query JSON" };
  }
  const queries = Array.isArray(inner.queries)
    ? normalizeSearchQueries(inner.queries)
    : [];
  if (!queries.length) return { ok: false, error: "queries array missing" };
  return { ok: true, queries };
}

export function parseFilterRefinementResult(result) {
  const outer = parseOuterResponse(result);
  if (!outer.ok) return outer;
  let inner;
  try {
    inner = JSON.parse(outer.text);
  } catch {
    return { ok: false, error: "gemini response was not valid filter JSON" };
  }
  const reply = String(inner.reply || "").trim();
  const videoSummary = String(inner.video_summary || "").trim();
  const parsedOptions = Array.isArray(inner.suggested_options)
    ? inner.suggested_options.map((option) => ({
      reason: String(option?.reason || "").trim(),
      blockingGuidance: String(option?.blocking_guidance || option?.blockingGuidance || option?.reason || "").trim(),
      proposedFilter: String(option?.proposed_filter || option?.proposedFilter || "").trim()
    })).filter((option) => option.reason && option.proposedFilter).slice(0, 5)
    : [];
  const legacyReasons = Array.isArray(inner.suggested_reasons)
    ? inner.suggested_reasons.map((reason) => String(reason || "").trim()).filter(Boolean).slice(0, 5)
    : [];
  const proposedFilter = String(inner.proposed_filter || "").trim() || parsedOptions[0]?.proposedFilter || "";
  const suggestedOptions = parsedOptions.length
    ? parsedOptions
    : legacyReasons.map((reason) => ({ reason, blockingGuidance: reason, proposedFilter }));
  const suggestedReasons = suggestedOptions.length
    ? suggestedOptions.map((option) => option.reason)
    : legacyReasons;
  if (!reply) return { ok: false, error: "reply missing" };
  if (!proposedFilter) return { ok: false, error: "proposed_filter missing" };
  return { ok: true, reply, videoSummary, suggestedReasons, suggestedOptions, proposedFilter };
}

function alignDecisions(candidates, decisions) {
  const byId = new Map(decisions.map((decision) => [String(decision.id), decision]));
  return candidates.map((candidate) => {
    const decision = byId.get(String(candidate.id));
    if (!decision || !isAllowedDecision(decision.decision)) {
      return blocked(candidate, "AI did not return a valid decision for this item.");
    }
    return {
      ...candidate,
      gate: {
        decision: decision.decision,
        confidence: Number(decision.confidence) || 0,
        reason: String(decision.reason || ""),
        labels: Array.isArray(decision.labels) ? decision.labels.map(String).slice(0, 6) : [],
        safeTitle: String(decision.safe_title || candidate.title || "")
      }
    };
  });
}

function blocked(candidate, reason) {
  return {
    ...candidate,
    gate: {
      decision: "block",
      confidence: 1,
      reason,
      labels: ["fail-closed"],
      safeTitle: candidate.title || "Blocked item"
    }
  };
}

function normalizeSearchQueries(values) {
  return [...new Set(values
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .map((value) => value.replace(/\s+/g, " ").slice(0, 80))
    .filter((value) => value.length >= 2))]
    .slice(0, 6);
}
