import test from "node:test";
import assert from "node:assert/strict";
import { parseFilterRefinementResult, parseGeminiResult } from "../src/gemini.js";

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

test("parses Gemini filter refinement JSON", () => {
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
  assert.equal(parsed.reply, "I tightened the filter around practical material.");
  assert.equal(parsed.videoSummary, "The video looks like drama commentary.");
  assert.deepEqual(parsed.suggestedReasons, ["It is drama commentary", "It is clickbait"]);
  assert.equal(parsed.proposedFilter, "Show practical Rust tutorials. Block drama and clickbait.");
});

test("fails closed on invalid Gemini filter refinement JSON", () => {
  const parsed = parseFilterRefinementResult({
    ok: true,
    stdout: JSON.stringify({ response: JSON.stringify({ reply: "No prompt." }) })
  });
  assert.equal(parsed.ok, false);
});
