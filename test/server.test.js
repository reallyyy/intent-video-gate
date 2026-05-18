import test from "node:test";
import assert from "node:assert/strict";
import { applyKeywordPrefilter, selectFeedCandidates } from "../src/server.js";

test("pre-classification candidates include YouTube when Bilibili cache is full", () => {
  const cachedBilibili = Array.from({ length: 80 }, (_, index) => ({
    id: `bilibili:cached-${index}`,
    platform: "bilibili",
    title: `Bilibili cached video ${index}`,
    url: `https://www.bilibili.com/video/BVcached${String(index).padStart(2, "0")}`
  }));
  const youtubeItems = Array.from({ length: 8 }, (_, index) => ({
    id: `youtube:yt-${index}`,
    platform: "youtube",
    title: `YouTube recommendation ${index}`,
    url: `https://www.youtube.com/watch?v=yt-${index}`
  }));

  const candidates = selectFeedCandidates({ cachedBilibili, youtubeItems, limit: 80 });
  const platforms = candidates.map((item) => item.platform);

  assert.equal(candidates.length, 80);
  assert.equal(platforms.filter((platform) => platform === "youtube").length, 8);
  assert.equal(platforms.filter((platform) => platform === "bilibili").length, 72);
});

test("keyword prefilter blocks matching candidates before AI classification", () => {
  const candidates = [
    {
      id: "bilibili:warhammer",
      platform: "bilibili",
      title: "少女战锤 lore clip",
      uploader: "Uploader",
      url: "https://www.bilibili.com/video/BVblocked"
    },
    {
      id: "bilibili:music",
      platform: "bilibili",
      title: "Warm melodic music video",
      uploader: "Musician",
      url: "https://www.bilibili.com/video/BVmusic"
    }
  ];

  const result = applyKeywordPrefilter(candidates, ["战锤"]);

  assert.deepEqual(result.allowed.map((item) => item.id), ["bilibili:music"]);
  assert.deepEqual(result.blocked.map((item) => item.id), ["bilibili:warhammer"]);
  assert.equal(result.blocked[0].gate.reason, "Blocked by keyword: 战锤");
});

test("music candidates are not locally blocked without keyword matches", () => {
  const candidates = [
    {
      id: "bilibili:music",
      platform: "bilibili",
      title: "Atmospheric bittersweet indie song",
      uploader: "Musician",
      url: "https://www.bilibili.com/video/BVmusic"
    }
  ];

  const result = applyKeywordPrefilter(candidates, ["warhammer", "道士"]);

  assert.equal(result.allowed.length, 1);
  assert.equal(result.blocked.length, 0);
});
