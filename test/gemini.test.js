import test from "node:test";
import assert from "node:assert/strict";
import { buildBilibiliSearchQueryPrompt, buildPrompt, buildSubtitleTranslationPrompt, parseFilterRefinementResult, parseGeminiResult, parseSearchQueryResult } from "../src/gemini.js";

test("parses Gemini outer JSON and inner decision JSON", () => {
  const result = {
    ok: true,
    stdout: JSON.stringify({
      response: JSON.stringify({
        decisions: [
          {
            id: "youtube:abc",
            decision: "allow",
            confidence: 0.91,
            reason: "Directly matches the intent.",
            labels: ["tutorial"],
            safe_title: "Rust lifetimes"
          }
        ]
      })
    })
  };
  const parsed = parseGeminiResult(result);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.decisions[0].decision, "allow");
});

test("fails closed on invalid Gemini response JSON", () => {
  const parsed = parseGeminiResult({ ok: true, stdout: JSON.stringify({ response: "not json" }) });
  assert.equal(parsed.ok, false);
});

test("parses Gemini Bilibili search query JSON", () => {
  const parsed = parseSearchQueryResult({
    ok: true,
    stdout: JSON.stringify({
      response: JSON.stringify({
        queries: [" 科技纪录片 ", "深度访谈", "科技纪录片"]
      })
    })
  });

  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.queries, ["科技纪录片", "深度访谈"]);
});

test("Bilibili search query prompt targets native Chinese content", () => {
  const prompt = buildBilibiliSearchQueryPrompt({
    intent: "thoughtful documentaries",
    blockKeywords: [],
    approved: [],
    rejectedBilibili: []
  });

  assert.match(prompt, /native Chinese/);
  assert.match(prompt, /Translate the user's intent into Chinese/);
  assert.match(prompt, /NOT English-translated or bilingual/);
});

test("classification prompt treats explicit music allowances as authoritative", () => {
  const prompt = buildPrompt("Music is allowed when it is warm and melodic.", [
    {
      id: "bilibili:music",
      platform: "bilibili",
      title: "Warm melodic MV",
      uploader: "Musician",
      url: "https://www.bilibili.com/video/BVmusic"
    }
  ], {});

  assert.equal(prompt.includes("pure music"), false);
  assert.match(prompt, /source of truth/);
  assert.match(prompt, /music taste/);
  assert.match(prompt, /music-no-subtitles/);
});

test("parses Gemini filter refinement JSON", () => {
  const result = {
    ok: true,
    stdout: JSON.stringify({
      response: JSON.stringify({
        reply: "I tightened the filter around practical material.",
        video_summary: "The video looks like drama commentary.",
        suggested_options: [
          {
            reason: "It is drama commentary",
            blocking_guidance: "Block drama commentary.",
            proposed_filter: "Show practical Rust tutorials. Block drama commentary."
          },
          {
            reason: "It is clickbait",
            blocking_guidance: "Block clickbait.",
            proposed_filter: "Show practical Rust tutorials. Block clickbait."
          }
        ],
        proposed_filter: "Show practical Rust tutorials. Block drama commentary."
      })
    })
  };
  const parsed = parseFilterRefinementResult(result);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.reply, "I tightened the filter around practical material.");
  assert.equal(parsed.videoSummary, "The video looks like drama commentary.");
  assert.deepEqual(parsed.suggestedReasons, ["It is drama commentary", "It is clickbait"]);
  assert.deepEqual(parsed.suggestedOptions, [
    {
      reason: "It is drama commentary",
      blockingGuidance: "Block drama commentary.",
      proposedFilter: "Show practical Rust tutorials. Block drama commentary."
    },
    {
      reason: "It is clickbait",
      blockingGuidance: "Block clickbait.",
      proposedFilter: "Show practical Rust tutorials. Block clickbait."
    }
  ]);
  assert.equal(parsed.proposedFilter, "Show practical Rust tutorials. Block drama commentary.");
});

test("maps legacy Gemini refinement reasons to shared proposal options", () => {
  const result = {
    ok: true,
    stdout: JSON.stringify({
      response: JSON.stringify({
        reply: "I tightened the filter around practical material.",
        video_summary: "The video looks like drama commentary.",
        suggested_reasons: ["It is drama commentary", "It is clickbait"],
        proposed_filter: "Show practical Rust tutorials. Block drama and clickbait."
      })
    })
  };
  const parsed = parseFilterRefinementResult(result);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.suggestedOptions, [
    {
      reason: "It is drama commentary",
      blockingGuidance: "It is drama commentary",
      proposedFilter: "Show practical Rust tutorials. Block drama and clickbait."
    },
    {
      reason: "It is clickbait",
      blockingGuidance: "It is clickbait",
      proposedFilter: "Show practical Rust tutorials. Block drama and clickbait."
    }
  ]);
});

test("fails closed on invalid Gemini filter refinement JSON", () => {
  const parsed = parseFilterRefinementResult({
    ok: true,
    stdout: JSON.stringify({ response: JSON.stringify({ reply: "No prompt." }) })
  });
  assert.equal(parsed.ok, false);
});

test("buildSubtitleTranslationPrompt produces valid prompt with Chinese lines", () => {
  const lines = ["你好世界", "这是一个测试", "第三行"];
  const prompt = buildSubtitleTranslationPrompt(lines);
  assert.match(prompt, /Translate these Chinese subtitle lines/);
  assert.match(prompt, /JSON array/);
  assert.match(prompt, /你好世界/);
  assert.match(prompt, /这是一个测试/);
  assert.match(prompt, /第三行/);
});
