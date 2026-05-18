import test from "node:test";
import assert from "node:assert/strict";
import { normalizeYtdlpJson } from "../src/video.js";

test("normalizes yt-dlp video JSON", () => {
  const item = normalizeYtdlpJson({
    id: "abc123",
    title: "A focused video",
    uploader: "Teacher",
    duration: 321,
    webpage_url: "https://www.youtube.com/watch?v=abc123",
    description: "Useful"
  });

  assert.equal(item.id, "youtube:abc123");
  assert.equal(item.platform, "youtube");
  assert.equal(item.url, "https://www.youtube.com/watch?v=abc123");
  assert.equal(item.durationSeconds, 321);
});

