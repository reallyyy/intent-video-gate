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

function buildPrompt(intent, candidates, preferences) {
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
Block only videos that clearly violate the filter, are obvious distractions, are low-effort entertainment, pure music, celebrity gossip, clickbait, unrelated gaming/comedy, or blocked channels.
When uncertain, allow if the video is plausibly informative, educational, practical, technical, language-learning, news-analysis, documentary-like, or otherwise useful under the filter.

Return only valid JSON, no markdown, with this shape:
{"decisions":[{"id":"candidate id","decision":"allow|block|ask","confidence":0.0,"reason":"short reason","labels":["short"],"safe_title":"clean title"}]}

Candidates:
${JSON.stringify(compact, null, 2)}`;
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

Write a concise reply to the user, summarize relevant video details, offer 3 to 5 potential reasons, and propose a full replacement filter prompt.
Preserve the user's original positive intent. Add only the minimum specific blocking guidance needed to avoid similar future recommendations. Do not make the filter hostile, overbroad, or unrelated to the current prompt.

Return only valid JSON, no markdown, with this shape:
{"reply":"short response to user","video_summary":"short factual summary of relevant details","suggested_reasons":["reason user can choose"],"proposed_filter":"complete updated filter prompt"}`;
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
  const suggestedReasons = Array.isArray(inner.suggested_reasons)
    ? inner.suggested_reasons.map((reason) => String(reason || "").trim()).filter(Boolean).slice(0, 5)
    : [];
  const proposedFilter = String(inner.proposed_filter || "").trim();
  if (!reply) return { ok: false, error: "reply missing" };
  if (!proposedFilter) return { ok: false, error: "proposed_filter missing" };
  return { ok: true, reply, videoSummary, suggestedReasons, proposedFilter };
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
