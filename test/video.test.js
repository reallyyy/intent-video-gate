import test from "node:test";
import assert from "node:assert/strict";
import { englishCapableBilibiliSubtitleTracks, normalizeYtdlpJson } from "../src/video.js";

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

test("detects English-capable Bilibili subtitle tracks", () => {
  const tracks = [
    { language: "zh-CN", label: "中文（自动生成）" },
    { language: "en-US", label: "English" },
    { language: "ai-zh", label: "中英双语字幕" },
    { language: "zh-Hant", label: "繁體中文" }
  ];

  assert.deepEqual(
    englishCapableBilibiliSubtitleTracks(tracks).map((track) => track.label),
    ["English", "中英双语字幕"]
  );
});
